# Phase 5A — Pistis Daemon Mode

Long-lived HTTP service exposing Pistis as an always-on remediation backend. Replaces the "run the CLI per incident" workflow with a single daemon NEAT (or any caller) can POST incidents to.

This PR ships **everything Pistis-side** that's needed for the integration. NEAT-side changes are documented in the Phase 5B handoff doc and are out of scope here.

Audited against this spec before the PR opens.

## Why a daemon

Two reasons:

1. **Latency**: spinning up Pistis cold for every incident pays the CLI startup + module load cost (a few hundred ms) on the critical path. A daemon amortises it.
2. **State**: in-flight runs need a registry so callers can poll status or fetch artifacts. A daemon owns that state naturally.

The daemon does NOT change the semantics of a single run. Same orchestration, same workers, same reviewers, same artifact format. It just wraps the existing `runPistis()` in an HTTP surface and tracks active runs.

## Scope

**In**:
- `PistisDaemon` class in `src/daemon/server.ts` — owns the `Bun.serve` instance
- HTTP surface:
  - `GET  /health` — liveness + version + supported features
  - `POST /run` — accept an incident JSON body, kick off a run, return `{ runId, status: "queued" }`
  - `GET  /runs` — list known runs (id, status, started/finished timestamps)
  - `GET  /runs/:id` — full run state including `final-report.md` link
  - `GET  /runs/:id/artifacts` — list artifact paths
  - `GET  /runs/:id/artifacts/:name` — fetch one artifact (text or binary)
  - `POST /runs/:id/cancel` — best-effort cancellation
- Bearer auth via `PISTIS_TOKEN` env var; constant-time compare; missing token → daemon refuses to start
- In-memory `RunRegistry` + disk artifacts (same `ArtifactStore` as CLI runs)
- Optional webhook callback: if `--webhook-url` is set, daemon POSTs the final run summary to that URL when each run completes (auth: signed body via shared secret `PISTIS_WEBHOOK_SECRET`)
- New CLI subcommand: `pistis daemon --port 7777 --token <secret> [--webhook-url ...] [--use-router] [--use-kimi-reviewer]`
- Incident JSON Schema exported at `packages/pistis/schemas/incident.schema.json` (matches `NormalizedIncident`); ships as part of the package's published files so NEAT can validate against it
- Result sink: every run writes `result.json` to its artifact dir containing the verdict, diff (if any), risk notes, and tool-call summary

**Out**:
- No queue backend (single-process, in-memory queue is fine for MVP)
- No multi-tenancy / per-project daemon (one daemon serves all projects; matches the existing Pistis CLI assumption)
- No persistent run registry across restarts (in-memory only; disk artifacts survive)
- No streaming / SSE responses (poll-based)
- No retries inside the daemon for failed callbacks (logged once)
- No rate limiting beyond what the underlying Bun.serve provides
- No NEAT-side changes (those go in Phase 5B handoff)

## API shapes

### `GET /health` — unauthenticated

```json
{
  "ok": true,
  "version": "0.2.0",
  "uptimeSeconds": 142
}
```

**Deliberately minimal.** No feature list (would leak whether Kimi/Router are wired up to anyone who can reach the port). `version` is the same string that's in `package.json` and is already public on the published package. `uptimeSeconds` is informational. That's it.

A separate authenticated `GET /capabilities` returns the feature list (whether `--use-router` / `--use-kimi-reviewer` are in effect, what models are configured) so legitimate clients can introspect.

### `POST /run`

Request body — same JSON Pistis CLI accepts via `--incident`. Plus optional run config:

```json
{
  "incident": {
    "incidentId": "INC-001",
    "primaryNodeId": "service:order-api",
    ...
  },
  "config": {
    "workspace": "/path/to/repo",
    "testCommands": ["npm test"],
    "approveRisk": [],
    "useRouter": true,
    "useKimiReviewer": true,
    "maxRetries": 2,
    "allowDirtyWorkspace": false
  }
}
```

Response:

```json
{
  "runId": "INC-001-2026-06-17T10-30-00Z",
  "status": "queued",
  "links": {
    "self": "/runs/INC-001-2026-06-17T10-30-00Z",
    "artifacts": "/runs/INC-001-2026-06-17T10-30-00Z/artifacts"
  }
}
```

The daemon validates `incident` against the incident JSON Schema synchronously and returns 400 with field-level issues if it fails. The actual orchestration runs async; clients poll `GET /runs/:id` for status.

### `GET /runs/:id`

```json
{
  "runId": "INC-001-2026-06-17T10-30-00Z",
  "incidentId": "INC-001",
  "status": "completed" | "running" | "queued" | "failed",
  "startedAt": "2026-06-17T10:30:00Z",
  "finishedAt": "2026-06-17T10:31:42Z",
  "verdict": "accepted" | "rejected" | "needs_retry" | "needs_human" | null,
  "classification": "runtime_exception",
  "artifacts": ["incident.json", "graph-context.json", "plan.md", "patch.diff", "result.json", "final-report.md"],
  "finalReportUrl": "/runs/.../artifacts/final-report.md",
  "diffUrl": "/runs/.../artifacts/patch.diff",
  "links": {
    "self": "/runs/...",
    "cancel": "/runs/.../cancel"
  }
}
```

### `GET /runs/:id/artifacts/:name`

Serves the file directly. Content-Type derived from extension (`.md` → text/markdown, `.json` → application/json, `.diff` → text/plain). Path traversal is blocked by **two** checks:

1. Regex: `name` must match `^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`
2. **Explicit `..` segment check**: every `/`-split segment is rejected if it equals `..` exactly. The regex alone allows `..` because `.` and `_` are in the character class — the segment check closes that.

Response size is capped at 10 MiB (configurable via `PISTIS_MAX_ARTIFACT_BYTES`). Larger artifacts return 413 with a clear error.

### `POST /runs/:id/cancel`

**Soft-cancel only.** The registry's run record is marked `cancelled` and the orchestration is allowed to run to completion in the background — its eventual result is discarded and `result.json` is overwritten with `{ status: "cancelled" }`. We do NOT pipe a cancellation flag through the orchestrator's role loop in this PR (that's intrusive surgery; future PR).

Reasoning: a real cancel needs a cooperative orchestrator that polls a flag between roles, which means changing `MultiAgentOrchestrator.run()` and every worker's retry loop. Out of scope here. Soft-cancel is honest about its semantics — the caller knows their run is "ignored" rather than "stopped."

Response: `{ ok: true, status: "cancelling" }`. Unknown runId → 404. Already-finished run → 409 with `{ error: "run already finished" }`.

## Auth

- Required env: `PISTIS_TOKEN`. Daemon **refuses to start** if it's empty or missing. No anonymous mode, no `--allow-anonymous` flag.
- Every request (except `GET /health`) must carry `Authorization: Bearer <PISTIS_TOKEN>`. Missing or mismatched → 401, no body details.
- **Constant-time compare strategy**: `crypto.timingSafeEqual` only works on equal-length buffers, and the caller-supplied token can be any length. Instead of length-padding (which leaks the expected length), the daemon SHA-256-hashes both the provided token and the expected token, then `timingSafeEqual`s the 32-byte hash digests. Both hashes are always the same length, so the comparison is genuinely constant-time and the expected token's length is not observable.
- `GET /health` is the **only** unauthenticated endpoint. Returns only `{ok, version, uptimeSeconds}` — no feature list, no model names, no config.
- Token is never logged, never echoed in error messages, never in artifacts. Same literal-substring redactor pattern as Phase 4A.

## Result sink — `result.json`

Written to the run's artifact dir when the run finishes. This is the file the webhook callback POSTs to NEAT:

```json
{
  "runId": "...",
  "incidentId": "...",
  "verdict": "accepted",
  "classification": "runtime_exception",
  "startedAt": "...",
  "finishedAt": "...",
  "filesChanged": ["src/handlers/order.ts"],
  "diff": "<unified diff>",
  "riskNotes": [],
  "reviewerName": "kimi-reviewer",
  "workerName": "router",
  "toolCallSummary": { "total": 3, "unknown": 0, "by_tool": { "get_edges": 1, "get_blast_radius": 2 } },
  "artifacts": ["incident.json", "patch.diff", "...", "result.json", "final-report.md"]
}
```

Stable schema. NEAT consumes this as the authoritative outcome.

## Webhook callback

Optional. If `--webhook-url` is set:

1. After `result.json` is written, daemon POSTs it to `<webhook-url>` with headers:
   - `Content-Type: application/json`
   - `X-Pistis-Run-Id: <runId>`
   - `X-Pistis-Signature: sha256=<hex hmac of body using PISTIS_WEBHOOK_SECRET>`
2. 10-second timeout. Non-2xx response → logged with the runId + status; **no retry** in this MVP (NEAT can poll `/runs/:id` as a fallback).
3. If `PISTIS_WEBHOOK_SECRET` is missing while `--webhook-url` is set, daemon refuses to start (signature is mandatory; we don't ship a "trust me" webhook).

## Request body limits

| Endpoint | Body cap | Behaviour on overflow |
|---|---|---|
| `POST /run` | 1 MiB (configurable via `PISTIS_MAX_RUN_BODY_BYTES`) | 413 with `{ error: "request body exceeds limit" }` |
| `POST /runs/:id/cancel` | 4 KiB | 413 |

`Content-Type` must be `application/json` on POSTs. Wrong content type → 415. Malformed JSON → 400 with `{ error: "invalid JSON body" }` (no parser internals echoed back).

## Workspace validation

`POST /run`'s `config.workspace` (when set) is validated synchronously before the run is queued:

- Must be an absolute path
- Must exist and be a directory
- Must be a git repo unless `config.allowNonGitWorkspace === true`
- Must be clean unless `config.allowDirtyWorkspace === true`

Failed validation → 400, no run started, no registry entry. This catches the most common misconfiguration before doing any LLM work.

## CORS (off by default)

Daemon does NOT add `Access-Control-Allow-*` headers by default — it's a server-to-server API. If `--cors-origin <origin>` is set, the daemon:

- Responds to OPTIONS preflight for any path with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Allow-Methods: GET, POST`
- Includes the same `Access-Control-Allow-Origin` on successful responses

`--cors-origin *` is allowed but logs a warning at startup — wide-open CORS on an authenticated API is usually a mistake.

## Graceful shutdown

`SIGINT` and `SIGTERM` handlers:

1. Stop accepting new connections (`Bun.serve.stop()`)
2. Wait up to `PISTIS_SHUTDOWN_TIMEOUT_MS` (default 30 s) for in-flight orchestrations to complete naturally
3. After timeout, hard-exit with code 1; in-flight runs are marked `interrupted` in the registry but their on-disk artifacts up to that point are preserved

The daemon logs `daemon: graceful shutdown initiated; <N> run(s) still in flight` on signal receipt.

## Run registry

```ts
class RunRegistry {
  start(runId: string, incidentId: string): RunRecord
  setStatus(runId: string, status: RunStatus, partial?: Partial<RunRecord>): void
  get(runId: string): RunRecord | undefined
  list(opts?: { limit?: number; status?: RunStatus }): RunRecord[]
  cancel(runId: string): boolean
}
```

Pure in-memory `Map<string, RunRecord>`. Bounded by `PISTIS_RUN_REGISTRY_MAX` (default 1000) — when full, oldest finished runs are evicted (running runs are never evicted).

## Incident JSON Schema

`packages/pistis/schemas/incident.schema.json` — a hand-written JSON Schema (draft 2020-12) that mirrors `NormalizedIncident`. Generated once and committed; not auto-derived from zod (zod-to-json-schema would add a new dep). A unit test verifies the schema rejects/accepts the same shapes `normalizeIncident()` does on a fixed set of cases.

Exported as a static file the daemon serves at `GET /schema/incident` so NEAT can fetch it without depending on the npm package.

## File layout

```
packages/pistis/src/daemon/
  server.ts             # PistisDaemon (owns Bun.serve)
  handlers.ts           # request handlers per endpoint
  auth.ts               # constant-time Bearer check
  run-registry.ts       # in-memory run state
  result-sink.ts        # writes result.json
  webhook.ts            # optional callback POST
  index.ts              # barrel
packages/pistis/schemas/
  incident.schema.json  # the JSON Schema NEAT consumes
packages/pistis/test/
  daemon-server.test.ts
  daemon-auth.test.ts
  run-registry.test.ts
  incident-schema.test.ts
  result-sink.test.ts
  webhook.test.ts
```

CLI: extend `src/cli.ts` with a new `pistis daemon` subcommand alongside `run`.

## Test plan

1. `POST /run` with valid incident → 202 returned with runId; registry entry exists with status "running".
2. `POST /run` with incident failing schema → 400 with field-level issues; no registry entry; no orchestration started.
3. `GET /run/:id` while in flight → returns `running`; after completion → returns `completed` with `verdict`.
4. `GET /runs` returns the list, sorted newest-first, limited by `?limit=` param.
5. `GET /runs/:id/artifacts/:name` returns the file with correct Content-Type. Path traversal (`../`) → 400.
6. `POST /runs/:id/cancel` sets the cancelled flag; subsequent `GET /runs/:id` returns `cancelled`.
7. Auth: request without `Authorization` → 401, no body details.
8. Auth: request with wrong Bearer → 401, no body details, constant-time compare verified (timing test).
9. Auth: `GET /health` works without auth.
10. Daemon refuses to start if `PISTIS_TOKEN` is empty or missing.
11. Daemon refuses to start if `--webhook-url` set but `PISTIS_WEBHOOK_SECRET` missing.
12. Webhook fires on completion with correct signature + headers.
13. Webhook 5xx response → logged once, daemon continues serving other requests.
14. `RunRegistry` evicts oldest finished runs when over `PISTIS_RUN_REGISTRY_MAX`; never evicts running runs.
15. `result.json` shape matches the spec for accepted, rejected, needs_human verdicts.
16. JSON Schema accepts every payload `normalizeIncident()` accepts in the existing incident-schema tests; rejects every payload it rejects.
17. `GET /schema/incident` returns the JSON Schema with Content-Type `application/schema+json`.
18. CLI: `pistis daemon --help` prints help; with no `PISTIS_TOKEN` env, exits non-zero with a clear error.
19. `/health` returns ONLY `{ok, version, uptimeSeconds}` — no `features`, `models`, or config-derived strings. Verified by snapshot check.
20. `GET /capabilities` requires auth; returns feature/model info to authenticated callers.
21. `GET /runs/:id/artifacts/<segment with ..>` → 400 with `path traversal not allowed`, even when the regex would otherwise pass (explicit `..` segment guard).
22. `GET /runs/:id/artifacts/<oversized file>` → 413 if > 10 MiB; valid response otherwise.
23. `POST /run` with non-existent workspace → 400 with workspace-error message; no registry entry created.
24. `POST /run` with dirty workspace and `allowDirtyWorkspace !== true` → 400.
25. `POST /run` with > 1 MiB body → 413.
26. `POST /run` with wrong Content-Type → 415.
27. CORS: with no `--cors-origin`, OPTIONS returns 405 / no `Access-Control-*` headers; with `--cors-origin https://example.test`, preflight returns 200 with the correct headers.
28. SIGTERM: handler stops accepting new connections; in-flight run completes; process exits cleanly. (Acknowledged: signal-handling test uses a subprocess; can be flaky on CI — falls back to direct call of the handler function if subprocess timing is unreliable.)

## Safety invariants — verified, unchanged

Daemon mode does not relax any existing Pistis invariant:

| Invariant | How daemon honours it |
|---|---|
| No auto-merge | Daemon never merges; same as CLI |
| No deploy | Daemon never deploys |
| No arbitrary shell | `runTestCommands` is the only shell path, same as CLI |
| External directory writes denied | `risk-gate` still runs; daemon doesn't unlock anything |
| No model transcripts in artifacts | Same redaction as Phase 4A/B/C |
| Tokens redacted | Both `PISTIS_TOKEN` and `PISTIS_WEBHOOK_SECRET` are caught by the same literal-substring redactor pattern |
| No PR creation | Daemon doesn't have a PR endpoint (Phase 5+) |

## Out of scope, explicitly

- No NEAT-side changes (those go in the Phase 5B handoff doc)
- No persistent run state across restarts
- No SSE / streaming
- No queue/worker decoupling
- No multi-tenant daemon
- No new model integrations beyond what Phase 4 shipped
- No retry on failed webhook POST

## Definition of done

- All Phase 5A tests green
- All existing tests still pass (was 230 after 4D; new tests add cleanly)
- `tsgo --noEmit` clean
- Audit doc maps every spec section
- No `PISTIS_TOKEN` or `PISTIS_WEBHOOK_SECRET` value appears in fixtures/assertions
- Daemon can be started locally with `bun run src/cli.ts daemon --port 7777 --token "$(openssl rand -hex 32)"` (manual smoke verified in audit)
