# Phase 4C — Kimi Reviewer

Real `AsyncContractReviewer` implementation backed by **Moonshot Kimi K2.7**. Replaces the role of `RuleBasedContractReviewer` in production runs with an LLM that can actually read the diff, drill into the NEAT graph with read-only tools, and either accept the patch, reject it, request a retry, escalate to a human, or — when rejection is the verdict — write its own corrected diff (READ AND BUGFIX).

Audited against this spec before the PR opens.

## Why Kimi K2.7 for the reviewer slot

The reviewer is the load-bearing safety net. It reads a fully-formed patch, the success criteria, the test report, and the prior agents' findings, and decides if production should accept this code. It must be:

- **Cross-family from the writer** so it has independent blind spots from MiniMax (the patch writer)
- **Strong at code reasoning** — better than Flash on subtle bugs, "fix vs mask", root-cause-vs-symptom distinctions
- **Cheap enough to run on every patch** — Opus's price would force escalation logic; Kimi's ~$0.30/M input + ~$2.50/M output makes always-on review affordable
- **Tool-use capable** — it needs to drill into NEAT for fresh blast-radius / edges / divergences / recent-incidents data, not just rely on the snapshot Flash took 30 seconds ago

K2.7 hits all four. The tool-use loop is what makes this PR a real upgrade over the rule-based reviewer.

## Scope

**In**:
- Implement a new async reviewer interface (`AsyncContractReviewer`) in `src/contract/async-reviewer.ts` — parallel to `ContractReviewer`, async, no changes to the existing sync interface
- `KimiReviewer` class in `src/reviewers/kimi-reviewer.ts` implementing `AsyncContractReviewer`
- Two-phase architecture: **VERIFY** (tool-using loop, up to 8 NEAT lookups) → **DECIDE** (verdict + reasons + criteriaResults) → optional **BUGFIX** (Kimi writes a corrected unified diff with tools disabled)
- Eight read-only NEAT tools exposed as Moonshot OpenAI-style function definitions
- Strict allowlist HTTP wrapper (`NeatReadOnlyClient`) — no write methods exist on the class, so a hallucinated tool name can never reach a write endpoint
- Iteration cap: 8 tool calls per review. Hitting the cap forces `verdict: "needs_human"` — never auto-approve at the cap
- Tool-call audit artifact: every tool call (name, args, result hash, latency) appended to `tool-calls.jsonl` under the run dir
- Moonshot OpenAI-compatible API via native `fetch`, `Authorization: Bearer <MOONSHOT_API_KEY>`
- Configurable model name (default `kimi-k2-7-instruct`, with note about API churn) and base URL
- Map all error paths → `ContractReview` verdicts cleanly: blocked → `needs_human`, transient HTTP errors → `needs_human` with reason
- Tool calls disabled during BUGFIX phase (verify and write are separate steps so each can be reasoned about)
- READ-AND-BUGFIX produces an `AgentResult`-shaped output the orchestrator can re-validate after applying

**Out** (later PRs):
- Wiring `KimiReviewer` into `OpenCodeSessionDispatcher` / `MultiAgentOrchestrator` — Phase 4D (router worker + async reviewer adapter)
- Best-of-N reviewer voting
- Streaming tool calls
- Tool-call concurrency (single-threaded for now; sequential calls are fine within the 8 budget)
- Persisting Kimi's intermediate `messages[]` state between contracts
- A different reviewer for critical classes (auth/payments/migrations) — handled by orchestration policy, not by KimiReviewer

## Pre-flight: a diff to review

Before the VERIFY phase runs at all, the reviewer checks `input.result.diff`. If it is undefined or empty, the reviewer returns `verdict: "needs_human"` with `reasons: ["KimiReviewer: AgentResult has no diff to review"]` without making any Moonshot call. This guards against an upstream bug where a patch worker returned `status: "completed"` without actually producing a diff — in that case there is nothing for Kimi to honestly review, so escalation is the only safe outcome.

## Two-phase architecture

```
KimiReviewer.review(input)
├── Phase 1: VERIFY
│   ├── Build initial conversation: system prompt + incident + graph context + contract +
│   │   patch summary + diff + test runs + prior findings
│   ├── Loop up to MAX_TOOL_CALLS = 8 times:
│   │   ├── Call Moonshot with `tools = READ_ONLY_TOOLS`
│   │   ├── If response is a `finish_reason: "tool_calls"`:
│   │   │   ├── For each tool call:
│   │   │   │   ├── Look up in allowlist (8 names)
│   │   │   │   ├── If unknown name → append { error: "tool not in allowlist" } to conversation as the tool result; LOG to tool-calls.jsonl with `error: "unknown_tool"`
│   │   │   │   ├── If known → call NeatReadOnlyClient method; append response to conversation; LOG
│   │   │   ├── Continue loop
│   │   ├── Else (final assistant message): break loop, hand off to DECIDE phase
│   ├── If loop hits MAX_TOOL_CALLS:
│   │   └── return ContractReview { verdict: "needs_human", reasons: ["iteration cap hit"] }
│
├── Phase 2: DECIDE
│   ├── Parse final assistant message as JSON:
│   │   { verdict: "accepted" | "rejected" | "needs_retry",
│   │     reasons: string[],
│   │     criteriaResults: [{criterion, status, evidence}] }
│   ├── If verdict is "accepted" or "needs_retry": return ContractReview as-is
│   ├── If verdict is "rejected" AND opts.attemptBugfix is true: enter Phase 3
│   ├── Else: return ContractReview { verdict: "rejected", ... }
│
└── Phase 3 (optional): BUGFIX
    ├── New Moonshot call WITH NO TOOLS (tools=[])
    ├── System prompt is the BUGFIX prompt, not the VERIFY one
    ├── Conversation includes:
    │   ├── The incident, contract, patch diff that was rejected
    │   ├── The verify-phase findings (verdict reasons, criteriaResults, tool call results)
    │   ├── Ask: produce a corrected unified diff that satisfies the criteria
    ├── Output: JSON { summary, diff, filesChanged, riskNotes, unresolvedQuestions }
    ├── KimiReviewer returns ContractReview { verdict: "needs_retry", nextPrompt: <serialised bugfix diff + summary> }
    │   The orchestrator's dispatcher loop is responsible for applying the bugfix diff and re-running validation;
    │   the reviewer never applies a diff itself (separation of concerns).
```

## The 8 tools

Each is a Moonshot `type: "function"` declaration. The descriptions are written for Kimi's tool-selection step, so they're verbose and intent-focused.

### 1. `get_node`

```json
{
  "type": "function",
  "function": {
    "name": "get_node",
    "description": "Look up a NEAT node by id. Use to confirm the patched service exists and to see its language, repo, and kind before deciding whether the patch makes sense in context.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string", "description": "NEAT node id, e.g. 'service:order-api'." }
      },
      "required": ["nodeId"]
    }
  }
}
```

Maps to `NeatReadOnlyClient.getNode(nodeId)` → `NeatClient.getNode`.

### 2. `get_edges`

```json
{
  "type": "function",
  "function": {
    "name": "get_edges",
    "description": "Get inbound and outbound edges for a node. Use to identify which services call into the patched node (callers that might break) and which services it depends on.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string" }
      },
      "required": ["nodeId"]
    }
  }
}
```

### 3. `get_blast_radius`

```json
{
  "type": "function",
  "function": {
    "name": "get_blast_radius",
    "description": "Estimate the downstream impact of a node failing. Returns the set of nodes reachable within `depth` edges. Use to quantify how much breaks if the patch is wrong.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string" },
        "depth": { "type": "integer", "minimum": 1, "maximum": 3, "default": 2 }
      },
      "required": ["nodeId"]
    }
  }
}
```

### 4. `get_dependencies`

```json
{
  "type": "function",
  "function": {
    "name": "get_dependencies",
    "description": "List declared dependencies of a node and whether each was recently changed. Use to spot if the bug or fix touches a dep with recent churn.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string" },
        "depth": { "type": "integer", "minimum": 1, "maximum": 3 }
      },
      "required": ["nodeId"]
    }
  }
}
```

### 5. `get_root_cause`

```json
{
  "type": "function",
  "function": {
    "name": "get_root_cause",
    "description": "Fetch NEAT's current root-cause candidate for a node. Use to re-verify that the root cause Flash captured is still the current candidate, since the graph evolves.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string" },
        "errorId": { "type": "string" }
      },
      "required": ["nodeId"]
    }
  }
}
```

### 6. `get_divergences`

```json
{
  "type": "function",
  "function": {
    "name": "get_divergences",
    "description": "List observed-vs-declared drift in the graph. Optionally filter to a single node. Use to catch implicit assumptions the patch makes about state that's drifted from declared truth.",
    "parameters": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string" }
      }
    }
  }
}
```

### 7. `list_incidents`

```json
{
  "type": "function",
  "function": {
    "name": "list_incidents",
    "description": "List recent NEAT incidents. Use to check if the node is already in a bad state we shouldn't pile more changes onto.",
    "parameters": {
      "type": "object",
      "properties": {
        "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
      }
    }
  }
}
```

### 8. `get_policy_violations`

```json
{
  "type": "function",
  "function": {
    "name": "get_policy_violations",
    "description": "List current policy violations. Use to block patches that would land on a node already non-compliant.",
    "parameters": {
      "type": "object",
      "properties": {
        "severity": { "type": "string", "enum": ["low", "medium", "high"] },
        "policyId": { "type": "string" }
      }
    }
  }
}
```

## NeatReadOnlyClient — defence-in-depth

Separate class from `NeatClient`. Only exposes the 8 methods listed above, taking the same parameters. Internally calls through to a `NeatClient` instance, but the wrapper has no `request`, `safe`, `buildUrl`, or any other generic transport method that could route a write.

```ts
export class NeatReadOnlyClient {
  constructor(private readonly inner: NeatClient) {}

  getNode(nodeId: string): Promise<ToolResult> { ... }
  getEdges(nodeId: string): Promise<ToolResult> { ... }
  getBlastRadius(nodeId: string, depth?: number): Promise<ToolResult> { ... }
  getDependencies(nodeId: string, depth?: number): Promise<ToolResult> { ... }
  getRootCause(nodeId: string, errorId?: string): Promise<ToolResult> { ... }
  getDivergences(nodeId?: string): Promise<ToolResult> { ... }
  listIncidents(limit?: number): Promise<ToolResult> { ... }
  getPolicyViolations(opts?: { severity?: string; policyId?: string }): Promise<ToolResult> { ... }
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }
```

All methods catch errors internally and return a discriminated union — Kimi never sees an exception, only a failed tool result it can react to.

Even if the system prompt is leaked, prompt-injected, or Kimi hallucinates, there is **no transport in the class** for any non-read method. `NeatClient.checkPolicies` (which POSTs) is never reachable through `NeatReadOnlyClient`.

## Iteration cap + audit artifact

```
MAX_TOOL_CALLS = 8
```

Counts every tool call Kimi attempts, including unknown-name attempts (which never reach NEAT but still cost a Moonshot round-trip). When the cap is reached, the reviewer stops the loop and returns `verdict: "needs_human"` with `reasons: ["iteration cap hit"]`. This is a hard rule — no auto-approve at the cap, regardless of what Kimi was about to do next.

Every tool call appends one JSON line to `tool-calls.jsonl` in the run directory:

```json
{ "ts": "2026-06-17T12:34:56Z", "iteration": 1, "tool": "get_edges", "args": { "nodeId": "service:order-api" }, "result_hash": "sha256:...", "latency_ms": 142, "ok": true }
{ "ts": "2026-06-17T12:34:56Z", "iteration": 2, "tool": "get_blastt_radius", "args": { "nodeId": "service:order-api" }, "ok": false, "error": "unknown_tool" }
```

Provides the audit trail for "what did Kimi actually look at when deciding."

## READ-AND-BUGFIX

When Kimi's VERIFY+DECIDE concludes `verdict: "rejected"`:

1. The reviewer checks `opts.attemptBugfix` (default `true` in production, `false` in tests where we want to assert reject paths)
2. **A fresh Moonshot conversation is started** (not a continuation of the VERIFY messages) so the new system prompt is the BUGFIX prompt and `tools = []` is set explicitly. Continuing the previous conversation would re-attach the VERIFY system prompt, which would mis-instruct Kimi at this stage.
3. The fresh conversation's user message includes: the incident, the contract, the rejected patch diff, the VERIFY verdict + reasons, and a digest of the tool-call findings from VERIFY. This gives Kimi its own analysis as input without inheriting the agentic-loop structure.
4. **Timeout for BUGFIX is `timeoutMs * 2`** because code generation is materially slower than the verification turns
5. Kimi returns `{ summary, diff, filesChanged, riskNotes, unresolvedQuestions }` — same shape as MiniMax patch output
6. The reviewer surfaces this as `verdict: "needs_retry"` with `nextPrompt` containing the serialised bugfix output

The dispatcher's retry loop is responsible for resetting the workspace and applying the bugfix diff via `git apply`. The reviewer never mutates the workspace itself — keeps the "review vs apply" boundary clean.

If `attemptBugfix` is false (or the bugfix call itself fails), the reviewer returns `verdict: "rejected"` with the original reasons.

## Mapping Kimi outputs → ContractReview verdicts

| Kimi DECIDE output | ContractReview verdict | Notes |
|---|---|---|
| `verdict: "accepted"` | `accepted` | passed all the criteria Kimi checked |
| `verdict: "rejected"` + BUGFIX succeeds | `needs_retry` with `nextPrompt = serialised bugfix diff` | dispatcher applies the diff and re-validates |
| `verdict: "rejected"` + BUGFIX disabled or fails | `rejected` | reasons preserved |
| `verdict: "needs_retry"` | `needs_retry` with `nextPrompt = Kimi's refinement prompt` | direct mapping |
| Iteration cap hit | `needs_human` with `reasons: ["iteration cap hit"]` | hard rule |
| Moonshot HTTP error path | `needs_human` with `reasons: ["KimiReviewer error: <redacted>"]` | never silently accept |
| Final assistant message not JSON | `needs_human` with `reasons: ["KimiReviewer output not JSON"]` | same — never silently accept |

## Moonshot API shape

OpenAI-compatible:

```
POST {base_url}/chat/completions
Headers:
  Authorization: Bearer {MOONSHOT_API_KEY}
  Content-Type: application/json

Body:
{
  "model": "kimi-k2-7-instruct",
  "messages": [...],
  "tools": [<the 8 tool schemas>],
  "tool_choice": "auto",
  "temperature": 0.2,
  "max_tokens": 4096
}
```

Default base URL: `https://api.moonshot.ai/v1` (also `https://api.moonshot.cn/v1` historically). The constructor accepts `baseUrl` overrides and `PISTIS_MOONSHOT_BASE_URL` env. The default model identifier (`kimi-k2-7-instruct`) is the user-stated K2.7; the actual API string may be `kimi-k2-7-chat`, `moonshot-v1-k2-7`, or similar — overridable via `PISTIS_MOONSHOT_MODEL`.

Tool-call response shape (per OpenAI):

```ts
choices[0].message = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_x", type: "function", function: { name: "get_edges", arguments: '{"nodeId":"..."}' } }
  ]
}
choices[0].finish_reason = "tool_calls"
```

Tool result is appended as:

```ts
{ role: "tool", tool_call_id: "call_x", content: "<JSON-stringified result>" }
```

## System prompts

**VERIFY prompt** (used in Phase 1+2):

```
You are the Pistis code reviewer. You receive a code patch that attempts to fix
an incident, along with the contract that bounded the patch, the test runs the
dispatcher executed, and prior agents' findings.

Your job: decide whether the patch should be ACCEPTED, REJECTED, or NEEDS_RETRY.

You have access to 8 read-only NEAT tools. Use them to verify implications you
can't determine from the patch alone — blast radius, dependency state, recent
incidents on the affected nodes, policy violations, divergences. You have a
budget of 8 tool calls total. Spend them on questions whose answer would
materially change your verdict.

When you've gathered enough evidence, emit a final JSON object — no prose, no
markdown fences, no further tool calls — matching:

{
  "verdict": "accepted" | "rejected" | "needs_retry",
  "reasons": ["<one sentence each>"],
  "criteriaResults": [
    { "criterion": "<exact success criterion text>",
      "status": "pass" | "fail" | "unknown",
      "evidence": ["<one item per piece of evidence>"] }
  ]
}

Verdict rules:
- ACCEPTED: every success criterion passes, no critical risks surfaced.
- REJECTED: a critical risk would land in production (security, data loss,
  blast radius too large to justify, etc.). The diff is bad enough that a
  retry won't fix it without a different approach.
- NEEDS_RETRY: criteria fail but the diff is recoverable with a refinement —
  e.g. missing edge case, wrong file touched, test still red. Include
  specific guidance for the next attempt in `reasons`.

You MUST emit JSON. You MUST NOT emit prose alongside JSON.
```

**BUGFIX prompt** (used in Phase 3):

```
You previously REJECTED a patch for an incident. Your verdict and reasoning
are below.

Now produce a corrected unified diff that addresses the rejection reasons and
satisfies every success criterion. You have NO tools in this phase — you must
produce the fix from the context you already have.

You MUST respect the contract's allowedFiles and forbiddenFiles. You MUST NOT
introduce new dependencies. You MUST NOT change function signatures named in
the incident stack trace unless the contract explicitly allows it.

Output ONLY a JSON object:

{
  "summary": "<1-2 sentences describing the fix>",
  "diff": "<git-style unified diff>",
  "filesChanged": ["<path>", ...],
  "riskNotes": ["<one sentence per residual risk>"],
  "unresolvedQuestions": ["<one sentence per open question>"]
}
```

## Error handling

| Failure | `ContractReview` verdict |
|---|---|
| 401/403 from Moonshot | `needs_human`, `reasons: ["KimiReviewer auth failed"]` (key never echoed) |
| 429 | one retry after Retry-After (capped 5 s); then `needs_human` with `["KimiReviewer rate limited"]` |
| 5xx | one retry; then `needs_human` with `["KimiReviewer server error: <status>"]` |
| `finish_reason: "content_filter"` during VERIFY or BUGFIX | `needs_human`, `["KimiReviewer blocked by content filter"]` |
| `finish_reason: "length"` | `needs_human`, `["KimiReviewer output truncated"]` (the verify call had not enough tokens to think — escalate, never auto-decide) |
| Final assistant message not JSON | `needs_human`, `["KimiReviewer output not JSON: <first 200 chars>"]` |
| Tool call to unknown name | logged to `tool-calls.jsonl` with `error: "unknown_tool"`; Kimi gets `{ ok: false, error: "tool not in allowlist" }` as the tool result and continues loop |
| Tool call arguments fail `JSON.parse` | logged with `error: "bad_arguments"`; Kimi gets `{ ok: false, error: "tool arguments were not valid JSON" }`; counts against iteration budget |
| `input.result.diff` is empty or missing | `needs_human` with `["KimiReviewer: AgentResult has no diff to review"]` — no Moonshot call made |
| Tool call latency > 10 s | tool result returned with `ok: false, error: "tool timed out"`; counts against iteration budget |
| Tool calls exceed `MAX_TOOL_CALLS` | hard escalation to `needs_human` |
| Network error / 60 s timeout | one retry; then `needs_human` with `["KimiReviewer unreachable"]` |
| `attemptBugfix` true and BUGFIX returns non-JSON or empty diff | fall back to `verdict: "rejected"` with original reasons; never silently accept the broken bugfix |

Invariant: **at no failure path does KimiReviewer return `verdict: "accepted"`.** Acceptance only ever comes from a clean DECIDE phase with valid JSON output.

## Env / config

- `MOONSHOT_API_KEY` — required; constructor throws if absent
- `PISTIS_MOONSHOT_MODEL` (optional) — overrides default model
- `PISTIS_MOONSHOT_BASE_URL` (optional) — overrides API base
- `PISTIS_KIMI_TOOL_BUDGET` (optional, default 8) — overrides iteration cap; runtime-clamped to `[1, 16]`

Constructor:

```ts
new KimiReviewer({
  apiKey?: string,
  model?: string,                  // defaults to "kimi-k2-7-instruct"
  baseUrl?: string,                // defaults to "https://api.moonshot.ai/v1"
  fetch?: typeof fetch,
  timeoutMs?: number,              // defaults 60_000
  neatClient: NeatClient,          // REQUIRED — wraps with NeatReadOnlyClient internally
  maxToolCalls?: number,           // defaults 8
  attemptBugfixOnReject?: boolean, // defaults true
  appendToolCallLog?: (line: string) => Promise<void>,  // injectable for tests; defaults to a no-op
})
```

The reviewer does NOT take a workspace — it never touches the workspace. It takes the diff text from `result.diff` and that's all the workspace state it sees.

## AsyncContractReviewer interface

New file `src/contract/async-reviewer.ts`:

```ts
import type { ContractReview } from "./types"
import type { ContractReviewerInput } from "./reviewer"
import type { GraphContext } from "../neat/context-builder"
import type { NormalizedIncident } from "../incident/schema"

export interface AsyncContractReviewerInput extends ContractReviewerInput {
  incident: NormalizedIncident
  graphContext: GraphContext
  primaryNodeId: string
}

export interface AsyncContractReviewer {
  readonly name: string
  review(input: AsyncContractReviewerInput): Promise<ContractReview>
}
```

This does NOT replace the existing sync `ContractReviewer`. Phase 4D will introduce an adapter so the orchestrator can use either. No existing tests change.

## File layout

```
packages/pistis/src/contract/
  async-reviewer.ts          # new interface, parallel to reviewer.ts

packages/pistis/src/reviewers/
  kimi-reviewer.ts           # the implementation
  kimi-prompts.ts            # VERIFY + BUGFIX system prompts
  kimi-tools.ts              # the 8 tool schemas
  neat-readonly-client.ts    # the allowlisted NEAT wrapper
  tool-call-log.ts           # append-only JSONL writer
  index.ts                   # barrel

packages/pistis/test/
  kimi-reviewer.test.ts      # stubbed Moonshot + stubbed NEAT
  neat-readonly-client.test.ts
  kimi-tools.test.ts         # schema sanity
```

## Test plan

All HTTP is stubbed. No real network. Tests don't read from disk for tool-call-log either — they inject `appendToolCallLog`.

1. Verify-only accept: Kimi makes 2 tool calls, returns `accepted` JSON → `ContractReview.verdict === "accepted"`; tool-calls.jsonl received 2 lines.
2. Verify-only needs_retry: returns `needs_retry` JSON → propagated through.
3. Verify reject WITHOUT bugfix attempt (`attemptBugfixOnReject: false`) → `verdict: "rejected"`, no second Moonshot call.
4. Verify reject WITH bugfix attempt: Phase 3 runs with `tools: []`, returns a bugfix JSON → `verdict: "needs_retry"`, `nextPrompt` contains the diff.
5. Iteration cap: stub makes Moonshot return tool_calls forever → reviewer stops after 8 attempts, returns `needs_human` with `iteration cap hit`.
6. Unknown tool name returned by Kimi → logged with `error: "unknown_tool"`; Kimi's next message gets `{ok: false, error: "tool not in allowlist"}`; NEAT client never called for that call.
7. Tool result is logged as one JSONL line per call (verify line count + line shape).
8. Each tool call's `result_hash` is reproducible — same args → same hash.
9. Auth via `Authorization: Bearer`, never in URL.
10. 401 from Moonshot → `needs_human`, key not in reasons.
11. `finish_reason: "length"` → `needs_human` (never auto-decide on truncated output).
12. `finish_reason: "content_filter"` → `needs_human`.
13. Final assistant message not JSON → `needs_human`, first 200 chars in reasons.
14. NeatReadOnlyClient: every method calls through to the corresponding `NeatClient` method; methods that don't exist on the wrapper cannot be invoked even via property access (TypeScript guarantees + runtime check).
15. NeatReadOnlyClient: a `NeatHttpError` from the inner client becomes `{ ok: false, error: ... }`, NOT an exception.
16. NeatReadOnlyClient: a `NeatNetworkError` from the inner client becomes `{ ok: false, error: ... }`.
17. The 8 tools' JSON schemas all validate against their declared parameter shapes (the test instantiates each tool's `parameters` JSON schema and checks `required` is satisfied for the documented use).
18. Request body shape pin (regression): `model`, `messages[0].role === "system"`, `tools.length === 8` in verify; `tools.length === 0` in bugfix.
19. `MAX_TOOL_CALLS` is respected after env override `PISTIS_KIMI_TOOL_BUDGET=3` — Kimi stops after 3 tool calls.
20. `attemptBugfix` BUGFIX call returns non-JSON → final `verdict: "rejected"` (never silently accept).
21. Two back-to-back reviews on the same contract produce byte-identical first user message (prefix stability for cache).
22. `input.result.diff` empty → `needs_human`, no Moonshot call made (verified by call-count assertion on the stub fetch).
23. Kimi's tool args are not valid JSON → logged with `error: "bad_arguments"`; the tool result delivered back to Kimi contains `tool arguments were not valid JSON`; counts against the budget.
24. BUGFIX phase uses `timeoutMs * 2` (verified by capturing the AbortController timer interval on the BUGFIX call).

## Out of scope, explicitly

- No `MultiAgentOrchestrator` / `OpenCodeSessionDispatcher` integration (Phase 4D)
- No changes to `RuleBasedContractReviewer` or its tests
- No changes to `NeatClient`
- No changes to artifact format beyond adding `tool-calls.jsonl`
- No new dependencies
- No NEAT-side changes
- No GitHub PR / human approval integration
- No streaming
- No tool-call concurrency

## Definition of done

- `bun test packages/pistis/test/kimi-reviewer.test.ts` green
- `bun test packages/pistis/test/neat-readonly-client.test.ts` green
- `bun test packages/pistis/test/kimi-tools.test.ts` green
- `tsgo --noEmit` clean
- Full pistis suite green (was 175 after 4B; new tests add cleanly)
- Audit doc maps every spec section to code or test
- No `MOONSHOT_API_KEY` value in any test fixture or assertion (placeholder used only to assert it does NOT leak)
- Invariant proved by tests: no failure path returns `verdict: "accepted"`
