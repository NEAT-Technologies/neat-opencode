# Phase 4A — Flash Worker

Real `Worker` implementation backed by Gemini 3.5 Flash. Handles the *reasoning* roles in the Phase 3 multi-role orchestration: `graph_context`, `root_cause`, `security_risk`. Does not touch files.

This document is the spec. The implementation is audited against it before the PR opens.

## Why Flash for these roles

The reasoning roles read the incident + graph context + prior findings and return a synthesised text summary plus risk notes. They never write code. Latency and cost matter more than peak code-reasoning quality, and the payloads are small. Flash 3.5 is the right tier: strong enough for the synthesis, cheap enough to run on every incident, and supports prompt caching to amortise the stable prefix across the 3 reasoning roles in one orchestration run.

## Scope

**In**:
- Implement `Worker` interface in `src/workers/flash-worker.ts`
- Handle `graph_context`, `root_cause`, `security_risk` roles
- Native `fetch` to Gemini REST `generateContent`
- Read `GEMINI_API_KEY` from env
- Configurable model name via constructor option (default `gemini-3.5-flash`)
- Force JSON output via `responseMimeType: "application/json"` so no fence-stripping is needed
- Map Gemini errors → `AgentResult.status = "blocked"` with redacted reason
- Throw `OutOfRoleError` if asked to run `patch`, `migration`, `test`, or `reviewer`

**Out** (later PRs handle these):
- `patch` / `migration` roles → Phase 4B (MiniMax worker)
- `reviewer` role → Phase 4C (Kimi reviewer)
- Explicit `CachedContent` API resource creation; rely on Gemini's implicit context caching for now
- Streaming responses (sync `generateContent` only)
- Tool use / function calling
- Image inputs
- Retries beyond a single transient-network retry

## API shape

Single endpoint:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
Headers:
  x-goog-api-key: <GEMINI_API_KEY>
  Content-Type: application/json
```

**Auth via header, not query string.** Sending the key as `?key=` puts it in the request URL, which can leak via downstream network-error logs, proxy logs, or library `error.message` properties that include the requested URL. The `x-goog-api-key` header is the equivalent auth path and stays out of URLs.

Request body:

```ts
{
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT_FOR_ROLE }] },
  contents: [
    { role: "user", parts: [{ text: USER_MESSAGE }] }
  ],
  generationConfig: {
    responseMimeType: "application/json",
    temperature: 0.2,
    thinkingConfig: { thinkingBudget: 0 }   // off by default for cheap roles
  }
}
```

Response (the shape we care about):

```ts
{
  candidates: [
    {
      content: { parts: [{ text: "<JSON string>" }] },
      finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | ...
    }
  ],
  usageMetadata: { promptTokenCount, candidatesTokenCount, ... }
}
```

`thinkingConfig.thinkingBudget = 0` defaults off because graph_context and security_risk don't need it. `root_cause` overrides to enable thinking (`thinkingBudget: -1` for dynamic).

**Graceful fallback for `thinkingConfig`**: if Gemini returns 400 specifically because `thinkingConfig` is unsupported (`error.message` contains "thinkingConfig" or "thinking_config"), the worker retries once without the field. This guards against API drift between Gemini variants without making the worker brittle to other 400s.

## System prompts per role

Each prompt asks for a JSON object matching a subset of `AgentResult`. The worker fills in `contractId`, `filesChanged: []`, `testsRun: []` itself.

### graph_context

Input fields surfaced in the user message:
- `incident` (summary)
- `contract.graphContext` (the full opaque blob)

Required output JSON:
```
{ "summary": "4 sentences synthesising the graph", "riskNotes": [], "unresolvedQuestions": [] }
```

### root_cause

Input fields:
- `incident`
- `contract.graphContext`
- `priorFindings.graph_context.summary` (referenced explicitly in the prompt)

Required output JSON:
```
{ "summary": "1-3 sentence hypothesis", "riskNotes": [], "unresolvedQuestions": ["..."] }
```

Enables thinking for this role only.

### security_risk

Input fields:
- `incident`
- `priorFindings.patch.filesChanged` and (when available) `priorFindings.patch.diff`

Required output JSON:
```
{ "summary": "...", "riskNotes": ["sensitive path: ...", "..."], "unresolvedQuestions": [] }
```

If no patch findings are present yet, returns `status: "blocked"` with `summary: "security_risk requires a prior patch role result"`.

## Prompt caching

Gemini's implicit context cache requires the stable prefix to cross a model-specific token threshold (≈1024 tokens for Flash) before it kicks in. In production-sized incidents the graph context is typically large enough; in unit tests it usually isn't.

Strategy: structure every Flash call with three concatenated blocks:

1. System instruction (per role, stable across all calls of that role)
2. A stable `INCIDENT_AND_GRAPH_CONTEXT` block (identical across all 3 reasoning roles in a single run)
3. A variable `ROLE_SPECIFIC_TAIL`

The implementation guarantees the first two blocks are byte-identical across reasoning roles in the same run. Cache hits then depend on whether the request crosses Gemini's threshold — which is a production concern, not a correctness concern.

What we verify:
- **Prefix structural stability** (testable, asserted in unit tests): two back-to-back calls with the same incident produce byte-identical leading prompt segments.
- **Cache hit ratio** (production observability, not unit-tested): logged from `usageMetadata.cachedContentTokenCount` when present, so we can tune in real traffic without depending on Gemini's caching policy in tests.

No explicit `CachedContent` resource is created in this PR.

## Error handling

| Failure | `AgentResult` mapping |
|---|---|
| 401/403 from Gemini | `status: "blocked"`, `summary: "Gemini auth failed"` (API key never echoed) |
| 429 | one retry after Retry-After (capped at 5 s); then `blocked` with `summary: "Gemini rate limited"` |
| 5xx | one retry; then `blocked` with `summary: "Gemini server error: <status>"` |
| `finishReason: "SAFETY"` | `blocked`, `summary: "Gemini blocked output for safety"` |
| Response text fails `JSON.parse` | `blocked`, `summary: "Gemini returned non-JSON output"`, `riskNotes: [first 200 chars of raw output]` |
| Missing required field in parsed JSON | `failed`, `summary: "Gemini output missing field: <name>"` |
| Network error / timeout (15 s) | one retry; then `blocked` with `summary: "Gemini unreachable"` |

No raw API responses are written to artifacts; only the parsed `AgentResult`. The API key never appears in any error message, log, or artifact.

## Env / config

- `GEMINI_API_KEY` — required; constructor throws if absent at construction time
- `PISTIS_FLASH_MODEL` (optional) — overrides default model name
- `PISTIS_FLASH_BASE_URL` (optional) — overrides API base; used by tests to point at a stub

Constructor signature:

```ts
new FlashWorker({
  apiKey?: string,            // defaults to process.env.GEMINI_API_KEY
  model?: string,             // defaults to process.env.PISTIS_FLASH_MODEL || "gemini-3.5-flash"
  baseUrl?: string,           // defaults to process.env.PISTIS_FLASH_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
  fetch?: typeof fetch,       // injectable for tests
  timeoutMs?: number,         // defaults 15_000; 45_000 for root_cause (thinking enabled)
})
```

Per-role timeout override: root_cause uses 3× the configured `timeoutMs` because thinking mode adds latency. Other roles use `timeoutMs` as-is.

## OutOfRoleError

```ts
export class OutOfRoleError extends Error {
  override readonly name = "OutOfRoleError"
  constructor(readonly attemptedRole: string, readonly worker: string) {
    super(`${worker} does not handle role: ${attemptedRole}`)
  }
}
```

The orchestrator can catch this and route the role to a different worker.

## File layout

```
packages/pistis/src/workers/
  flash-worker.ts          # the implementation
  flash-prompts.ts         # the 3 system prompts as plain string exports
  errors.ts                # OutOfRoleError
  index.ts                 # re-export FlashWorker
```

Tests:

```
packages/pistis/test/
  flash-worker.test.ts     # stubbed fetch, all roles + all error modes
```

## Test plan

Tests use a stub `fetch` that returns canned responses. No network calls.

1. `graph_context`: stub returns valid JSON → `AgentResult.summary` is the returned summary, `status === "completed"`.
2. `root_cause` references `priorFindings.graph_context.summary` — assert the prompt body contains the graph_context summary substring.
3. `security_risk` without prior patch → `status === "blocked"`.
4. `security_risk` with prior patch flagging sensitive paths → `riskNotes` contains them.
5. Unsupported role (`patch`) → `OutOfRoleError` thrown synchronously.
6. Gemini returns 401 → `status === "blocked"`, message does not contain the API key.
7. Gemini returns non-JSON text → `status === "blocked"`, riskNotes preserves first 200 chars.
8. Gemini returns valid JSON missing `summary` → `status === "failed"`.
9. Gemini returns `finishReason: "SAFETY"` → `status === "blocked"`.
10. The request body structure matches this doc (regression-pin): `systemInstruction.parts[0].text` equals the role's system prompt; `generationConfig.responseMimeType === "application/json"`; `thinkingConfig.thinkingBudget === 0` for graph_context/security_risk and `-1` for root_cause.
11. Two back-to-back calls with the same incident + graph context produce byte-identical leading prompt segments (proves prefix stability — necessary precondition for Gemini's implicit caching; actual cache hits depend on payload size and are not asserted).
12. When Gemini returns 400 with "thinkingConfig" in the error body, the worker retries once without `thinkingConfig` and succeeds if the retry returns valid JSON.
13. The request URL never contains the API key (auth-via-header invariant).

## Integration

This PR does **not** change the orchestrator. The orchestrator currently takes a single `worker: Worker` instance via `MultiAgentOrchestrator` constructor. To use the FlashWorker for the three reasoning roles, the integration site (later PR) will compose a router worker that delegates by role to FlashWorker / MinimaxWorker / etc.

For now, callers can use FlashWorker by:

```ts
const flash = new FlashWorker()
const result = await flash.run(contract, workspace) // throws OutOfRoleError for non-reasoning roles
```

The Phase 4D (final wiring) PR will add the router. Not in this PR.

## Out of scope, explicitly

- No changes to `MultiAgentOrchestrator`, `MultiRoleStubWorker`, the CLI, or any existing role.
- No new dependencies. Pure `fetch` + native JSON.
- No changes to artifact format.
- No NEAT changes.
- No PR / GitHub integration (that's still Phase 5).

## Definition of done

- `bun test packages/pistis/test/flash-worker.test.ts` green
- `tsgo` typecheck clean across the workspace
- Audit doc (in the PR description) maps every section of this MD to either: a code path that fulfils it, a test that verifies it, or an explicit deferral note
- No occurrences of `GEMINI_API_KEY` in any test fixture or log assertion
- No regressions in existing Pistis tests (111 should remain passing)
