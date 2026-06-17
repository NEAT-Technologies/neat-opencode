# Pistis ↔ NEAT Integration Handoff

**Audience**: NEAT engineering owner.
**Author**: Pistis (neat-opencode) side, Phase 5A complete.
**Status**: Pistis is integration-ready. NEAT needs five small changes to close the loop.

This document is the complete brief for what NEAT has to change to make the agentic remediation pipeline (Pistis) usable from the NEAT UI and API. The Pistis side is done — it ships as a long-lived HTTP daemon NEAT can call directly. No further Pistis changes are required to enable any of the items below.

---

## 1. TL;DR — what NEAT needs to do

Five tasks, ordered by dependency. Suggested PR breakdown in parentheses.

| # | Task | Why | Rough effort |
|---|---|---|---|
| **A** | Add a `PistisClient` inside NEAT that POSTs incidents to the Pistis daemon | Foundational — everything else depends on it | 0.5 day |
| **B** | Add `POST /pistis/runs` (Pistis webhook sink) + persist runs alongside incidents | Pistis posts result.json back here when each run completes | 1 day |
| **C** | Enforce the incident JSON Schema at NEAT's outbound boundary | Catches schema drift at the source instead of at Pistis | 0.5 day |
| **D** | Add UI: "Remediate with Pistis" button on the incidents page | The user-facing entrypoint | 0.5–1 day |
| **E** | Add UI: Pistis runs panel showing verdict, diff, risk notes, tool-call audit | Operators need to see what the agent did | 1–1.5 days |

**Total**: 3.5–4.5 days for a single engineer comfortable in the NEAT codebase. None of the changes are architecturally invasive — Pistis already exposes a clean HTTP surface that mirrors the existing NEAT REST style.

---

## 2. What Pistis already ships (so NEAT can call it)

### 2.1 The daemon

```bash
# Once Phase 5A is merged into opencode dev:
PISTIS_TOKEN="$(openssl rand -hex 32)" \
  bunx opencode pistis daemon --port 7777 --use-router --use-kimi-reviewer
```

The daemon is a long-lived `Bun.serve` HTTP server. Bind to localhost by default; expose only to NEAT's process (not the public internet).

### 2.2 HTTP surface NEAT consumes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | liveness check; returns `{ok, version, uptimeSeconds}` ONLY |
| `GET` | `/capabilities` | bearer | feature flags currently enabled on the daemon |
| `GET` | `/schema/incident` | bearer | the JSON Schema NEAT validates outgoing incidents against |
| `POST` | `/run` | bearer | submit an incident; returns `{runId, status: "queued"}` |
| `GET` | `/runs` | bearer | newest-first list of runs |
| `GET` | `/runs/:id` | bearer | full run record + verdict + artifact links |
| `GET` | `/runs/:id/artifacts/:name` | bearer | fetch one artifact (final-report.md, patch.diff, etc.) |
| `POST` | `/runs/:id/cancel` | bearer | soft-cancel; the run still completes but result is marked cancelled |

### 2.3 Authentication

Every request except `GET /health` requires `Authorization: Bearer <PISTIS_TOKEN>`. The daemon does a constant-time SHA-256 compare. NEAT should store the token in its existing secrets store and never log it.

### 2.4 The incident shape NEAT sends

Already documented in machine-readable form at `packages/pistis/schemas/incident.schema.json` in the opencode repo (and served at `GET /schema/incident` on the daemon). Quick reference:

```jsonc
{
  "incidentId": "INC-2026-0617-001",                 // required (or `id`)
  "primaryNodeId": "service:order-api",              // required
  "issueType": "runtime_exception",                  // optional but recommended
  "severity": "high",                                // info|low|medium|high|critical (fuzzy strings coerced)
  "message": "TypeError: Cannot read properties of undefined (reading 'id')",
  "candidateFiles": ["src/handlers/order.ts"],       // hints for Pistis
  "evidence": [
    { "stack": "TypeError: ...\n  at OrderHandler.attachCustomer (...:84:23)" }
  ],
  "failingEdge": { "from": "service:order-api", "to": "service:customer-api" },
  "errorId": "err-abc-123",
  "labels": ["regression", "post-deploy"],
  "metadata": { "team": "checkout" }
}
```

Everything beyond `incidentId` + `primaryNodeId` is optional. Pistis normalises aliases (`id` → `incidentId`, `summary` → `message`, snake_case → camelCase, etc.) but NEAT should produce the canonical shape going forward.

### 2.5 The result shape NEAT receives

When a run completes, Pistis posts `result.json` to the webhook URL (if configured) and serves it at `GET /runs/:id/artifacts/result.json`:

```jsonc
{
  "runId": "INC-2026-0617-001-2026-06-17T10-30-00-000Z",
  "incidentId": "INC-2026-0617-001",
  "verdict": "accepted",                             // accepted | rejected | needs_retry | needs_human | null
  "classification": "runtime_exception",
  "startedAt": "2026-06-17T10:30:00Z",
  "finishedAt": "2026-06-17T10:31:42Z",
  "filesChanged": ["src/handlers/order.ts"],
  "diff": "diff --git a/src/handlers/order.ts ...",  // full unified diff if a patch was produced
  "riskNotes": ["..."],
  "reviewerName": "kimi-reviewer",
  "workerName": "router",
  "toolCallSummary": { "total": 3, "unknown": 0, "by_tool": { "get_edges": 1, "get_blast_radius": 2 } },
  "artifacts": ["incident.json", "patch.diff", "result.json", "final-report.md", "tool-calls.jsonl"]
}
```

This is the authoritative outcome NEAT stores against the incident.

---

## 3. Task A — `PistisClient` inside NEAT

### Goal

A typed Node client that NEAT's incident-handling code uses to submit an incident to Pistis. Mirrors the existing NEAT `cli-client` pattern.

### Files to add (suggested)

```
packages/core/src/pistis-client.ts            # the client
packages/core/src/pistis-config.ts            # base URL + token resolution from env / settings
packages/core/test/pistis-client.test.ts
```

### Sketch

```ts
// packages/core/src/pistis-client.ts
export interface PistisClientOptions {
  baseUrl: string                      // default http://127.0.0.1:7777
  token: string                        // from secrets store
  fetchImpl?: typeof fetch             // injectable for tests
  timeoutMs?: number                   // default 10_000
}

export interface PistisRunRequest {
  incident: unknown                    // already conforms to the JSON Schema
  config?: {
    workspace?: string
    testCommands?: string[]
    approveRisk?: string[]
    useRouter?: boolean
    useKimiReviewer?: boolean
    maxRetries?: number
  }
}

export interface PistisRunQueued {
  runId: string
  status: "queued"
  links: { self: string; artifacts: string }
}

export class PistisClient {
  constructor(private readonly opts: PistisClientOptions) {}

  async submit(req: PistisRunRequest): Promise<PistisRunQueued> {
    return this.json("POST", "/run", req)
  }

  async getRun(runId: string): Promise<PistisRunRecord> { ... }
  async listRuns(opts?: { limit?: number; status?: string }): Promise<{ runs: PistisRunRecord[] }> { ... }
  async getArtifact(runId: string, name: string): Promise<string> { ... }
  async cancel(runId: string): Promise<{ ok: true }> { ... }
  async getCapabilities(): Promise<PistisCapabilities> { ... }
  async getSchema(): Promise<unknown> { ... }
}
```

### Auth + base URL resolution

Read from these in priority order:
1. `PISTIS_BASE_URL` env (default `http://127.0.0.1:7777`)
2. `PISTIS_TOKEN` env (no default — required)

Match the pattern used by `resolveNeatBaseUrl` / `resolveNeatAuthToken` in Pistis's `NeatClient` — it's symmetric and the team already knows it.

### Tests

- Stubbed fetch verifies request body shape (matches PistisRunRequest)
- Auth header includes `Bearer <token>` and the token never lands in URLs
- Network error → returns a typed `PistisUnreachableError`
- Daemon 401 → typed `PistisAuthError`
- Daemon 400 (schema) → typed `PistisIncidentValidationError` exposing the field-level message Pistis returned

### Acceptance

```ts
const client = new PistisClient({ baseUrl, token })
const { runId } = await client.submit({ incident, config: { workspace: process.cwd() } })
const record = await client.getRun(runId)
expect(record.status).toBe("completed")
```

---

## 4. Task B — Webhook sink + run persistence

### Goal

NEAT gains an endpoint Pistis posts to when each run completes, plus storage so NEAT can render past runs without round-tripping to the daemon.

### NEAT API additions

```
POST /pistis/runs            ← Pistis -> NEAT (the webhook target)
GET  /pistis/runs            list (newest-first, paginated)
GET  /pistis/runs/:runId     full record
GET  /pistis/runs?incidentId=INC-...   filter by incident
```

### Webhook security

Every webhook POST from Pistis carries two headers:

```
X-Pistis-Run-Id: <runId>
X-Pistis-Signature: sha256=<hex HMAC-SHA256 of body using PISTIS_WEBHOOK_SECRET>
```

NEAT's `POST /pistis/runs` MUST:
1. Reject any request without the signature header → 401
2. Recompute HMAC and compare with `crypto.timingSafeEqual` → 401 on mismatch
3. Parse the body against the result.json schema (mirror of `ResultSinkInput` in `src/daemon/result-sink.ts`)
4. Persist the run record (see storage below)
5. Return 200 — Pistis does NOT retry on failure

### Storage

Suggest a new `pistis_runs` table or KV namespace, keyed by `runId`, with the same fields as `ResultSinkInput`. Cross-reference `incidentId` → `runId` so the incidents page can show "Pistis runs for this incident."

### Webhook configuration

When NEAT operators run the Pistis daemon, they pass:

```bash
pistis daemon \
  --port 7777 \
  --webhook-url "https://neat.local/pistis/runs" \
  ...
# Plus env:
PISTIS_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

The same `PISTIS_WEBHOOK_SECRET` is shared into NEAT's env so NEAT can verify the signature.

### Tests on NEAT side

- POST with valid signature → 200 + record persisted
- POST with bad signature → 401
- POST with missing signature header → 401
- POST with malformed body → 400
- GET /pistis/runs returns newest-first
- GET /pistis/runs?incidentId=X filters correctly

---

## 5. Task C — Enforce incident JSON Schema at NEAT's outbound boundary

### Goal

Catch schema drift at the source. NEAT validates the incident JSON against the canonical schema *before* sending it to Pistis. If a NEAT change accidentally drops a required field, the unit test fails — not a production Pistis run.

### How

1. Add the Pistis schema as a build-time dependency. Either:
   - `npm install @opencode-ai/pistis@^0.2.0` (vendor it via the npm package), then load `packages/pistis/schemas/incident.schema.json` from `node_modules`
   - OR fetch from `GET /schema/incident` at build time and commit a copy into `packages/core/schemas/`
2. Wire a validator (ajv works fine) into the code path that produces the incident JSON for Pistis
3. The validator runs in dev/CI; in prod, it can either throw or log + send a stripped-down version. Recommendation: throw in dev, log + send in prod. Schema drift becomes a P0 alert, not a silent outage.

### Test

```ts
import schema from "@opencode-ai/pistis/schemas/incident.schema.json"
import { buildPistisIncident } from "../src/pistis-incident-builder"

test("every NEAT-produced incident validates against the Pistis schema", () => {
  for (const sample of incidentSamples) {
    const out = buildPistisIncident(sample)
    expect(ajv.validate(schema, out)).toBe(true)
  }
})
```

---

## 6. Task D — "Remediate with Pistis" button

### Goal

A button on the incidents page that:
1. Submits the incident to Pistis via `PistisClient`
2. Shows the resulting `runId` immediately
3. Links to a "Pistis run details" view that polls for completion

### Suggested UX

- Button visible on every incident page (next to existing actions)
- Only enabled when `GET /capabilities` confirms the daemon is reachable
- Disabled with a tooltip ("Pistis daemon not configured") when not
- On click: spinner → confirmation toast with the runId → link to the run details page
- Critical-class incidents (auth / payments / migrations / policy) should trigger a confirmation modal before submission — these are the cases where human-in-the-loop matters most. The classification is in `result.json.classification` after the run; the UI can suppress auto-apply for those even if the verdict is `accepted`.

### Files

```
packages/web/app/incidents/[id]/RemediateButton.tsx   # the button
packages/web/app/incidents/[id]/runs/[runId]/page.tsx # run details
packages/web/app/api/pistis/submit/route.ts           # NEAT-side proxy (avoids exposing PISTIS_TOKEN to the browser)
```

The submit goes through a NEAT server route — never call the Pistis daemon directly from the browser. The `PISTIS_TOKEN` should never leave the NEAT server process.

### Polling vs SSE

Pistis's daemon does NOT stream. Run details page polls `GET /pistis/runs/:runId` (NEAT side, which reads from the persist store populated by the webhook) every 2 seconds while status is `queued` or `running`. Stops polling once status is terminal (`completed`, `rejected`, `needs_human`, `cancelled`, `failed`).

---

## 7. Task E — Pistis runs panel

### Goal

Surface the verdict, diff, risk notes, and tool-call audit for each completed run so the user understands what the agent did and decides whether to merge.

### Suggested layout

```
┌─────────────────────────────────────────────────────────────┐
│ Verdict: ACCEPTED    Classification: runtime_exception      │
│ Started: 10:30:00    Finished: 10:31:42  (1m 42s)           │
│ Reviewer: kimi-reviewer    Worker: router                   │
├─────────────────────────────────────────────────────────────┤
│ Files changed                                               │
│   • src/handlers/order.ts  (+8 −1)                          │
├─────────────────────────────────────────────────────────────┤
│ Diff                                                        │
│   <syntax-highlighted unified diff>                         │
├─────────────────────────────────────────────────────────────┤
│ Risk notes                                                  │
│   • <one per riskNote>                                      │
├─────────────────────────────────────────────────────────────┤
│ Tool-call audit                                             │
│   • get_edges(service:order-api) — 142ms                    │
│   • get_blast_radius(service:order-api, 2) — 89ms           │
│   • get_blast_radius(service:order-api, 3) — 102ms          │
└─────────────────────────────────────────────────────────────┘
[ Cancel ]  [ Open final report ↗ ]
```

### Tool-call audit

Pulled from the `tool-calls.jsonl` artifact via `GET /runs/:id/artifacts/tool-calls.jsonl`. This is the audit trail showing exactly which NEAT graph endpoints Kimi consulted while reviewing. Important for trust — operators can see the reviewer did its homework, and security can later prove no write paths were touched.

### Approval flow (UI-only; Pistis stays read-only)

When verdict is `accepted`:
- Display the diff with a green "Approve & Merge" button
- That button is a NEAT-side action that opens a PR or pushes a branch (your existing infra) — Pistis itself does NOT merge, that was an explicit project constraint

When verdict is `needs_human` or `rejected`:
- No approve button
- Show the reasons array verbatim
- "Mark resolved manually" closes the incident in NEAT without taking Pistis's diff

### Critical classes

For `policy_violation`, `db_schema_or_query`, and incidents touching auth / payments / migrations, the UI should require an additional confirmation (typed phrase or two-person rule) before "Approve & Merge" is enabled. Pistis flags these in `classification` but does not enforce the gate — that's a NEAT UI concern.

---

## 8. Suggested rollout order

1. **Sprint 1**: Task A + Task B (the daemon round-trip works end-to-end; no UI yet, but the wiring is testable via curl + integration tests)
2. **Sprint 2**: Task C + a minimal Task D (button submits, links to a "run details" page that just shows raw JSON)
3. **Sprint 3**: Task E (proper UI with diff renderer and tool-call audit)

Behind a feature flag the whole way. The Pistis daemon can be deployed first because nothing in NEAT depends on it until Task A is wired up.

---

## 9. Authentication model summary

There are three secrets in play. Document them in NEAT's secret rotation runbook:

| Secret | Lives in | Used by | Purpose |
|---|---|---|---|
| `PISTIS_TOKEN` | NEAT env (and Pistis daemon env) | NEAT → Pistis requests | Bearer auth on every Pistis HTTP call |
| `PISTIS_WEBHOOK_SECRET` | NEAT env (and Pistis daemon env) | Pistis → NEAT webhook | HMAC signing of `POST /pistis/runs` bodies |
| `NEAT_AUTH_TOKEN` | already exists in NEAT | Pistis → NEAT graph queries (via KimiReviewer's tool use) | Read-only NEAT graph access during patch review |

Same rotation cadence as your existing auth tokens. Pistis already does literal-substring redaction of `PISTIS_TOKEN` in any error message that could end up in an artifact — the NEAT side should do the same for `PISTIS_WEBHOOK_SECRET`.

---

## 10. Open questions / decisions for the CEO

These don't block the integration but are worth deciding before Task D ships:

| Question | Default if undecided |
|---|---|
| Should "Remediate with Pistis" be visible on every incident, or only certain severities? | Every incident; UI shows verdict reasons even when Pistis declines |
| Should `accepted` patches auto-create a draft PR in the corresponding GitHub repo? | No — keep approval explicit in NEAT UI for now |
| Should the Pistis daemon run per-project (like the recent NEAT daemon refactor) or single-instance? | Single-instance is simpler and matches the current Pistis assumption; revisit if multi-project becomes painful |
| Should Pistis runs be visible to all NEAT users or restricted by team/project ownership? | Restrict to project owners — matches the existing incident view's permission model |
| Should the daemon be reachable from outside the NEAT process (e.g. CI calling it directly)? | No — bind to localhost; CI can talk to Pistis the same way NEAT does, via a separate daemon instance per CI runner |

---

## 11. Where to find more

| Topic | Location |
|---|---|
| Pistis daemon API spec (authoritative) | `neat-opencode/packages/pistis/phases/PHASE_5A_PISTIS_DAEMON.md` |
| Daemon implementation source | `neat-opencode/packages/pistis/src/daemon/` |
| Incident JSON Schema | `neat-opencode/packages/pistis/schemas/incident.schema.json` |
| Result.json shape | `neat-opencode/packages/pistis/src/daemon/result-sink.ts` (`ResultSinkInput`) |
| KimiReviewer tool-call audit format | `neat-opencode/packages/pistis/src/reviewers/tool-call-log.ts` |
| Pistis safety invariants (no auto-merge, no deploy, etc.) | `neat-opencode/packages/pistis/phases/PHASE_5A_PISTIS_DAEMON.md` § "Safety invariants" |

---

## 12. What Pistis will NOT do (for security review)

These are deliberate constraints — please don't ask the Pistis side to relax them without going through the project owner:

- **Pistis never opens a GitHub PR.** Diffs are produced and reviewed; merging is NEAT's responsibility through your existing infra.
- **Pistis never deploys.** Pure code-edit + test-run + review.
- **Pistis never runs arbitrary shell commands.** Only the `validationCommands` declared in the contract, via `runTestCommands`.
- **Pistis writes only to `--workspace` and the artifact dir.** External directory writes are denied by the risk gate.
- **Pistis writes nothing to NEAT.** Even with the webhook configured, NEAT owns its persistence; Pistis only posts result.json and never mutates NEAT's graph or policies.
- **Kimi's NEAT tool use is strictly read-only.** Eight allowlisted endpoints, no transport for any write method on the wrapper class. Verified by prototype-level allowlist tests.
- **API keys never appear in artifacts or error messages.** Redacted by literal-substring replacement at the boundary.

---

## 13. Status of the Pistis side

All four model integrations (Gemini Flash, MiniMax M3, Kimi K2.7) and the daemon are merged-pending in the opencode repo as PRs #4–#8 against the `pistis-phase-*` branches. They stack cleanly; the integration is end-to-end testable today against stubbed model endpoints. Real-API smoke runs require the three env vars (`GEMINI_API_KEY`, `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`) and a `PISTIS_TOKEN`.

The Pistis side is on hold for NEAT-side integration. Any clarifying questions on the daemon API shape or the safety invariants should come back to the Pistis team for an authoritative answer — please don't infer behaviour from the codebase alone, the project has strict rules we'd rather over-communicate than break.
