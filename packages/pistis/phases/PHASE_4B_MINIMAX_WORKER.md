# Phase 4B — MiniMax Worker

Real `Worker` implementation backed by MiniMax M3. Handles the *code-writing* roles in the Phase 3 multi-role orchestration: `patch`, `migration`. Produces unified diffs and applies them to the workspace.

Audited against this spec before the PR opens.

## Why MiniMax M3 for these roles

The code-writing roles take a fully-formed contract (allowedFiles, successCriteria, priorFindings) and produce a tightly-scoped edit. They don't need to plan, classify, or reason about graph state — that work already happened in Flash's reasoning roles. They need to write correct code under strict bounds. M3 is the right tier: strong code generation, 512K context (enough for the contract + the full content of the allowedFiles + the prior findings), and aggressive cache pricing ($0.06/M cached input) makes the stable prefix nearly free across retries and parallel best-of-N workers.

## Scope

**In**:
- Implement `Worker` interface in `src/workers/minimax-worker.ts`
- Handle `patch` and `migration` roles
- OpenAI-compatible chat-completions POST to MiniMax via native `fetch`
- Read `MINIMAX_API_KEY` from env; `Authorization: Bearer <key>` header
- Configurable model name (default `MiniMax-M3`) and base URL
- Bundle the current contents of `allowedFiles` into the prompt so M3 can produce a precise diff
- Force structured output (JSON) so the worker receives `{ "diff": "..." , "summary": "...", "filesChanged": [...] }` cleanly
- Parse the unified diff, defensively re-check it touches only `allowedFiles` (defence-in-depth — `OpenCodeSessionDispatcher` already verifies via `git diff` after the fact, but failing fast in the worker is cheaper)
- Apply the diff to the workspace using `git apply --whitespace=nowarn --3way`
- Map MiniMax errors → `AgentResult.status = "blocked"` with redacted reason
- Throw `OutOfRoleError` if asked to handle reasoning roles or `reviewer`

**Out** (later PRs):
- Best-of-N parallel workers + consensus — design notes only in this doc; implementation in Phase 4D (router worker)
- Tool use / function calling — patch workers don't need NEAT lookups
- Streaming responses
- Image inputs
- Retries beyond one transient-network retry
- The `test` role (no LLM, the orchestrator handles it directly)

## API shape

MiniMax exposes an OpenAI-compatible chat-completions API.

```
POST {base_url}/chat/completions
Headers:
  Authorization: Bearer {MINIMAX_API_KEY}
  Content-Type: application/json

Body:
{
  "model": "MiniMax-M3",
  "messages": [
    { "role": "system", "content": SYSTEM_PROMPT_FOR_ROLE },
    { "role": "user",   "content": USER_MESSAGE }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.1,
  "max_tokens": 8192
}
```

Default base URL: `https://api.minimaxi.com/v1`. Overridable via env.

**MiniMax has used multiple production hostnames** (`api.minimaxi.com`, `api.minimax.chat`, `api.minimax.io`) at different times. The constructor accepts a `baseUrl` override and reads `PISTIS_MINIMAX_BASE_URL` from env so the running deployment can point at whichever hostname is correct at integration time. Model identifier (`MiniMax-M3`) is similarly tentative — MiniMax has shipped names like `abab*`, `MiniMax-Text-*`, and `MiniMax-M*` across releases. Override via `PISTIS_MINIMAX_MODEL`. The unit tests do not depend on either default value.

Response shape (the parts we care about):

```ts
{
  id: string,
  choices: [
    {
      message: { role: "assistant", content: "<JSON string>" },
      finish_reason: "stop" | "length" | "content_filter"
    }
  ],
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    prompt_tokens_details?: { cached_tokens: number }   // when cache hits
  }
}
```

We log `usage.prompt_tokens_details.cached_tokens` when present (production observability), but tests do not assert on it.

**Graceful fallback for `response_format`**: if MiniMax returns a 400 with `response_format` referenced in the error body, the worker retries once *without* the `response_format` field, relying on the system-prompt instruction to format output as JSON. The downstream JSON parser handles the slightly higher risk of fence-wrapped output by detecting and stripping a single matched pair of triple backticks if the raw content starts with ` ``` ` or ` ```json `. No other deviation tolerated.

## System prompts per role

Both prompts force a JSON output:

```json
{
  "summary": "1-2 sentences describing what the patch does",
  "diff": "<unified diff text>",
  "filesChanged": ["<path>", ...],
  "riskNotes": [],
  "unresolvedQuestions": []
}
```

### patch (role)

The prompt:

- States the worker's bounds: only files in `allowedFiles` may be modified; nothing in `forbiddenFiles` may appear in the diff
- Names the success criteria explicitly and tells the model the patch must satisfy every one
- Cites the `priorFindings.root_cause.summary` (if present) as the authoritative root cause
- Provides the current contents of each `allowedFile`
- Requires a unified diff (`diff --git a/X b/X` header format)
- Forbids: new dependencies, signature changes, comments that reference incident IDs or "PISTIS", try/catch around the bug site to mask it

### migration (role)

The prompt:

- States that the output is a NEW migration file under `migrations/`, never an edit to an existing migration
- Names the success criteria
- Requires the diff to start with `diff --git a/migrations/NNNN_*.sql b/migrations/NNNN_*.sql` followed by `new file mode 100644` and `index 0000000..0000000` (explicit placeholder so `git apply` accepts the new-file diff without expecting a pre-existing blob)
- Forbids: schema rewrites that drop data; non-idempotent statements without explicit guards; cross-table joins in a single migration

## Bundling allowedFiles into the prompt

For each path in `contract.allowedFiles`:
1. Resolve it under `workspace.cwd`
2. If the file exists, read its UTF-8 content (skip binary by magic-byte check)
3. Include in the user message as:

```
=== FILE: <path> ===
<content, capped at 32 KiB per file with `<truncated: N bytes>` marker>
```

4. If the file does not exist (typical for migration role's not-yet-created file), include:

```
=== FILE: <path> ===
<file does not exist yet — worker must create it>
```

Total bundled file content capped at 256 KiB; if exceeded, the worker returns `status: "failed"` with summary `"allowedFiles content exceeds 256 KiB bundle cap"`. Phase 4D's router worker will eventually split such cases across multiple contract retries; for now the cap is conservative.

**Truncation risk (acknowledged, not mitigated in this PR)**: when a single file exceeds `perFileByteCap` (32 KiB), the worker truncates to the head and appends `<truncated: N bytes>`. The relevant function may be past the truncation point. This is a deliberate trade-off — the right fix is a tighter contract (`allowedFiles` should rarely include 32+ KiB files); the worker fails the contract author, not the user, by surfacing `truncated` markers prominently and including `riskNotes: ["file <X> was truncated; patch may be incomplete"]` in the result. A smarter context-windowed truncation can come later if traffic shows it's needed.

## User message structure

Three blocks, same pattern as Flash:

1. STABLE: incident + graphContext (JSON.stringify, 2-space) — byte-identical across retries of the same contract
2. PRIOR_FINDINGS (if present): graph_context summary, root_cause summary
3. VARIABLE_TAIL: success criteria, constraints, bundled file contents, the ask

Stable-prefix structure exists so MiniMax's implicit cache can amortise across the (potentially N parallel) workers in a best-of-N run, and across retries of the same contract.

## Pre-flight: workspace must be a git repo

Before making the API call, the worker checks `workspace.isGitRepo === true`. If not, it returns `AgentResult.status = "failed"` with `summary = "MinimaxWorker requires a git workspace (workspace.isGitRepo === false)"`. The orchestrator already enforces this on the dispatcher side, but failing in the worker before the API call saves both tokens and time when something upstream is misconfigured.

## Defensive allowedFiles check on the worker side

Before applying the diff, the worker parses every `+++ b/<path>` and `--- a/<path>` line out of it and verifies:

- Every path matches one of `contract.allowedFiles` exactly (path normalised through `path.posix.normalize`)
- No path matches any glob in `contract.forbiddenFiles`
- No path escapes `workspace.cwd` via `..`

If any path fails, the diff is rejected; the worker returns `AgentResult.status = "blocked"` with `summary = "diff touched disallowed file: <path>"` and the diff is NOT applied. This is defence-in-depth — `OpenCodeSessionDispatcher` already runs the same check post-application via `git diff --name-only`, but failing in the worker means the workspace is never even briefly modified with disallowed changes.

## Applying the diff

`git apply --whitespace=nowarn` against `workspace.cwd`. (No `--3way`: it requires `index abc..def` SHAs that match the workspace blobs, which the model can't compute reliably. Plain `git apply` is what we want.) If `git apply` returns non-zero, the worker:

1. Captures the git stderr (redacted for safety — no key leakage possible since we never put the key in the diff text, but redact any 401-style messages anyway)
2. Returns `AgentResult.status = "failed"` with `summary = "git apply failed: <first line of stderr>"`
3. Does NOT retry (one git apply attempt per worker call; the orchestrator's retry loop handles re-running the whole contract)

The worker never runs `git add`, `git commit`, or any branch-mutating command. The dispatcher does the diff capture and any rollback.

## Error handling

| Failure | `AgentResult` mapping |
|---|---|
| 401 from MiniMax | `blocked`, `summary: "MiniMax auth failed"` (key never echoed) |
| 429 | one retry after Retry-After (capped 5 s); then `blocked` "MiniMax rate limited" |
| 5xx | one retry; then `blocked` "MiniMax server error: <status>" |
| `finish_reason: "content_filter"` | `blocked`, "MiniMax blocked output for content_filter" |
| `finish_reason: "length"` | `failed`, "MiniMax output truncated — increase max_tokens or split contract" |
| Response content not JSON | `blocked`, "MiniMax returned non-JSON output: <first 200 chars>" |
| JSON missing `diff` or `summary` | `failed`, "MiniMax output missing field: <name>" |
| Diff touches disallowed file | `blocked`, "diff touched disallowed file: <path>" — diff NOT applied |
| `git apply` non-zero | `failed`, "git apply failed: <stderr line>" |
| Network error / 30 s timeout | one retry; then `blocked` "MiniMax unreachable" |

No raw responses are written to artifacts; only the parsed AgentResult plus the post-apply unified diff captured by the dispatcher.

**Redactor strategy**: simpler than Flash's regex-based AIza matcher. The worker captures the literal `apiKey` value at construction time and replaces every occurrence of that exact string with `"[redacted]"` anywhere it would land in an `AgentResult.summary` or returned error. This works for any MiniMax key format (current keys are long JWT-shaped tokens; future formats may differ). The literal-substring approach also covers the case where an upstream library accidentally interpolates the bearer token into an error message.

## Env / config

- `MINIMAX_API_KEY` — required; constructor throws if absent
- `PISTIS_MINIMAX_MODEL` (optional) — overrides default model name
- `PISTIS_MINIMAX_BASE_URL` (optional) — overrides API base; used by tests
- Default timeout: 30 000 ms (longer than Flash because code generation is slower)

Constructor:

```ts
new MinimaxWorker({
  apiKey?: string,
  model?: string,                   // defaults to "MiniMax-M3"
  baseUrl?: string,                 // defaults to "https://api.minimaxi.com/v1"
  fetch?: typeof fetch,
  timeoutMs?: number,               // defaults 30_000
  gitApply?: (cwd, diff) => Promise<{ok, stderr}>,   // injectable for tests
  fileBundleByteCap?: number,       // defaults 256 * 1024
  perFileByteCap?: number,          // defaults 32 * 1024
})
```

## File layout

```
packages/pistis/src/workers/
  minimax-worker.ts         # the implementation
  minimax-prompts.ts        # the 2 system prompts
  diff-parser.ts            # parse + validate unified diff (also reusable later)
  git-apply.ts              # thin wrapper around `git apply`

packages/pistis/test/
  minimax-worker.test.ts    # stubbed fetch + stubbed gitApply, all roles + errors
  diff-parser.test.ts       # standalone tests for the parser
```

Re-export `MinimaxWorker` from `src/workers/index.ts`.

## Test plan

All HTTP and `git apply` are stubbed. No real network, no real workspace edits (tmpdir + fake gitApply).

1. `patch` valid response → diff applied, `AgentResult.status = "completed"`, `filesChanged` populated.
2. `migration` valid response → new file path appears in `filesChanged`; the diff has `new file mode` line.
3. Diff that touches a file outside `allowedFiles` → `blocked`, diff NOT applied (verify by checking the stub `gitApply` was never called).
4. Diff that touches a path matching `forbiddenFiles` → same as #3.
5. Malformed diff (no `diff --git` header) → `blocked` with "non-JSON" or "missing field" depending on which check fires first.
6. MiniMax returns 401 → `blocked`, key never appears in summary.
7. MiniMax returns `finish_reason: "length"` → `failed`, summary mentions truncation.
8. MiniMax returns `finish_reason: "content_filter"` → `blocked`.
9. MiniMax returns non-JSON content → `blocked`, first 200 chars preserved.
10. JSON missing `diff` field → `failed`.
11. `git apply` returns non-zero → `failed`, summary contains first stderr line.
12. Unsupported role (`graph_context`) → `OutOfRoleError`.
13. Request body shape (regression-pin): `model`, `messages[0].role === "system"`, `response_format.type === "json_object"`, `temperature === 0.1`.
14. API key sent via `Authorization: Bearer` header, never in URL or message body.
15. Bundled files appear in the user message under `=== FILE: <path> ===` markers.
16. File content over per-file byte cap → `<truncated: N bytes>` marker in the prompt.
17. Total bundle exceeding cap → `failed` with cap message; no API call made.
18. Two back-to-back calls with the same contract → byte-identical leading prompt segments (prefix stability for cache).
19. `workspace.isGitRepo === false` → `failed` with the git-repo-required summary; no API call made.
20. MiniMax returns 400 with `response_format` in the error body → retry once without `response_format`; success path: parse the (possibly fence-wrapped) JSON; assert fence-stripping works.
21. File truncated past `perFileByteCap` → user message contains `<truncated: N bytes>` marker AND the resulting `AgentResult.riskNotes` contains a truncation warning.

## Best-of-N notes (informational; not implemented in this PR)

The architecture supports running N parallel `MinimaxWorker.run()` calls with the same contract and picking the best result by reviewer consensus (or by Kimi-as-judge). Phase 4D adds the router that does this. The `MinimaxWorker` itself is stateless and concurrency-safe — each call uses its own `AbortController`, its own workspace state snapshot (caller is responsible for resetting between attempts), and produces an independent `AgentResult`.

For the test, parallel best-of-N is out of scope; we ship the single-shot variant.

## Out of scope, explicitly

- No changes to `MultiAgentOrchestrator`, `MultiRoleStubWorker`, CLI, artifact format, or NEAT
- No router worker (Phase 4D)
- No new dependencies
- No `git` commit/push from this worker
- No PR / GitHub integration

## Definition of done

- `bun test packages/pistis/test/minimax-worker.test.ts` green
- `bun test packages/pistis/test/diff-parser.test.ts` green
- `tsgo` typecheck clean across the workspace
- Full pistis suite continues green (was 132 after Phase 4A; new tests add cleanly)
- Audit doc (`PHASE_4B_MINIMAX_WORKER_AUDIT.md`) maps every section here to code or test
- No `MINIMAX_API_KEY` value appears in any test fixture or assertion (a placeholder string is used only to verify it does NOT leak)
- No regressions in Phase 4A FlashWorker tests
