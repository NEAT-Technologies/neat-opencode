# Phase 4A — Implementation Audit

Walks `PHASE_4A_FLASH_WORKER.md` section by section. Each row maps a spec commitment to the code or test that fulfils it (or to an explicit deferral). Audit performed before opening the PR.

## Scope — In

| Commitment | Fulfilment |
|---|---|
| Implement `Worker` interface in `src/workers/flash-worker.ts` | `flash-worker.ts:46` — `class FlashWorker implements Worker` |
| Handle `graph_context`, `root_cause`, `security_risk` | `flash-worker.ts:11` — `SUPPORTED_ROLES`; `flash-worker.ts:78` — guard in `run()` |
| Native `fetch` to Gemini REST `generateContent` | `flash-worker.ts:194` — `this.fetchImpl(request.url, ...)`; URL built in `buildRequest()` |
| Read `GEMINI_API_KEY` from env | `flash-worker.ts:62` — constructor reads `process.env.GEMINI_API_KEY`; throws if absent |
| Configurable model (default `gemini-3.5-flash`) | `flash-worker.ts:13`, `flash-worker.ts:73` — `DEFAULT_MODEL` + `PISTIS_FLASH_MODEL` env override |
| Force JSON output via `responseMimeType` | `flash-worker.ts:111` — `generationConfig.responseMimeType: "application/json"` |
| Map Gemini errors → `AgentResult.status="blocked"` with redacted reason | `flash-worker.ts:130–166` — `dispatch()` returns blocked variants; `redact()` strips Google-key-shaped substrings |
| Throw `OutOfRoleError` on patch/migration/test/reviewer | `flash-worker.ts:79–81` — checked first in `run()` |

## Scope — Out (explicit deferrals)

| Commitment | Verification |
|---|---|
| No `patch` / `migration` impl | `SUPPORTED_ROLES` excludes them; `OutOfRoleError` thrown |
| No `reviewer` impl | Same |
| No explicit `CachedContent` resource | No `cachedContent` field in request body |
| No streaming | Uses `generateContent`, not `streamGenerateContent` |
| No tool use / function calling | No `tools` field in request body |
| No image inputs | No `inlineData` parts |
| Single transient retry only | `TRANSIENT_RETRY_LIMIT = 1` (`flash-worker.ts:15`) |

## API shape

| Commitment | Fulfilment |
|---|---|
| `POST {baseUrl}/models/{model}:generateContent` | `flash-worker.ts:117` — URL constructed via `encodeURIComponent(model)` |
| Auth via `x-goog-api-key` header (not `?key=`) | `flash-worker.ts:198` — header set; **Test #13** asserts URL has no `key=` and no FAKE_KEY |
| Request body: `systemInstruction.parts`, `contents[].role/parts`, `generationConfig.{responseMimeType, temperature, thinkingConfig}` | `flash-worker.ts:106–115` — body constructed; **Test #10** pins body shape |
| `thinkingBudget = 0` for graph_context, security_risk; `-1` for root_cause | `flash-worker.ts:108` — derived from `enableThinking`; **Tests #10 + variant** verify each role |

## System prompts per role

| Commitment | Fulfilment |
|---|---|
| `graph_context`: 4-sentence synthesis, JSON output | `flash-prompts.ts:GRAPH_CONTEXT_SYSTEM_PROMPT`; **Test #1, #10** |
| `root_cause`: 1–3 sentence hypothesis, references prior graph_context | `flash-prompts.ts:ROOT_CAUSE_SYSTEM_PROMPT`; **Test #2** asserts prior summary lands in prompt |
| `security_risk`: scan filesChanged + diff, flag substantive risks only | `flash-prompts.ts:SECURITY_RISK_SYSTEM_PROMPT`; **Tests #3, #4, #10 variant** |
| Each prompt requires `summary` + `riskNotes` + `unresolvedQuestions` | All three prompts include the exact JSON shape |
| security_risk without prior patch → blocked | `flash-worker.ts:83–87` — pre-check in `run()`; **Test #3** verifies |

## Prompt caching

| Commitment | Fulfilment |
|---|---|
| 3-block prompt structure (stable prefix + prior findings + role tail) | `flash-worker.ts:251–283` — `buildUserMessage` / `buildStablePrefix` / `buildPriorFindingsBlock` / `buildRoleTail` |
| Byte-stable prefix across reasoning roles in one run | **Tests #11 + cross-role variant** — assert both INCIDENT and GRAPH CONTEXT blocks identical between graph_context and root_cause |
| Cache-hit ratio observability | Deferred per spec — `usageMetadata.cachedContentTokenCount` is available on the response shape (`flash-worker.ts:24`) but no logger added in this PR; production observability follow-up |

## Error handling table

| Spec row | Fulfilment |
|---|---|
| 401/403 → blocked, "Gemini auth failed" | `flash-worker.ts:139–141`; **Test #6** verifies + asserts FAKE_KEY not echoed |
| 429 → retry then blocked | `flash-worker.ts:146–153`; **"429 rate limit" test** verifies |
| 5xx → retry then blocked | `flash-worker.ts:154–157`; **"5xx" test** verifies |
| `finishReason: "SAFETY"` → blocked | `flash-worker.ts:160–162`; **Test #9** verifies (also covers BLOCKLIST, PROHIBITED_CONTENT) |
| Non-JSON output → blocked, first 200 chars preserved | `flash-worker.ts:168–172`; **Test #7** verifies length < 300 |
| Missing required field → failed | `flash-worker.ts:204–205`; **Test #8** verifies "missing field: summary" |
| Network error / timeout (15 s) → retry then blocked | `flash-worker.ts:218–228` + AbortController in `fetchOnce`; **"network error" test** verifies |
| API key never in error/log/artifact | `redact()` regex strips `AIza[\w\-]{20,}` from any summary that includes it; **Test #6** asserts |

## Env / config

| Commitment | Fulfilment |
|---|---|
| `GEMINI_API_KEY` required (throws if absent at construction) | `flash-worker.ts:63–65`; **"throws on construction" test** |
| `PISTIS_FLASH_MODEL` optional override | `flash-worker.ts:73` + **"reads model + base URL overrides from env" test** |
| `PISTIS_FLASH_BASE_URL` optional override | `flash-worker.ts:74` + same test |
| Constructor signature matches spec | `FlashWorkerOptions` (`flash-worker.ts:25–31`) matches spec interface |
| Root_cause uses 3× `timeoutMs` | `flash-worker.ts:119` — `enableThinking ? this.timeoutMs * 3 : this.timeoutMs`; `THINKING_TIMEOUT_MULTIPLIER = 3` |

## OutOfRoleError

| Commitment | Fulfilment |
|---|---|
| Class with `attemptedRole` + `worker` fields, `name = "OutOfRoleError"` | `src/workers/errors.ts:6–13` |

## File layout

| Commitment | Fulfilment |
|---|---|
| `src/workers/flash-worker.ts` | ✓ |
| `src/workers/flash-prompts.ts` | ✓ |
| `src/workers/errors.ts` | ✓ |
| `src/workers/index.ts` | ✓ |
| `test/flash-worker.test.ts` | ✓ |

## Test plan

| Spec # | Test | Result |
|---|---|---|
| 1 | `graph_context` valid response → completed | ✓ pass |
| 2 | `root_cause` prompt contains `priorFindings.graph_context.summary` | ✓ pass |
| 3 | `security_risk` without prior patch → blocked | ✓ pass |
| 4 | `security_risk` riskNotes preserved | ✓ pass |
| 5 | Unsupported role (`patch`) → `OutOfRoleError` | ✓ pass |
| 6 | 401 → blocked, key not echoed | ✓ pass |
| 7 | Non-JSON → blocked, first 200 chars | ✓ pass |
| 8 | Missing `summary` → failed | ✓ pass |
| 9 | `finishReason: "SAFETY"` → blocked | ✓ pass |
| 10 | Request body shape pin (system prompt + responseMimeType + thinkingConfig per role) | ✓ pass (3 sub-tests) |
| 11 | Identical inputs → byte-identical leading prompt segments (single role + cross-role) | ✓ pass (2 sub-tests; cross-role asserts both INCIDENT and GRAPH CONTEXT blocks) |
| 12 | 400 with thinkingConfig → retry without it succeeds | ✓ pass |
| 13 | Request URL never contains API key; sent via `x-goog-api-key` header | ✓ pass |

Plus 5 extras beyond the spec (constructor error paths, 429, 5xx, network error, env overrides). All green.

**Total: 21 tests, 49 expect() calls, all pass.**

## Integration

| Commitment | Verification |
|---|---|
| No changes to `MultiAgentOrchestrator` | `git diff pistis-phase-3..HEAD -- packages/pistis/src/orchestration/` → empty |
| No changes to `MultiRoleStubWorker` | Same — file untouched |
| No changes to CLI | `cli.ts` not in diff |
| No changes to any existing role | None of `src/orchestration/`, `src/contract/`, `src/opencode/` modified |
| FlashWorker is opt-in via construction | Caller must explicitly `new FlashWorker()`; orchestrator default is unchanged |

## Out of scope, explicitly

| Commitment | Verification |
|---|---|
| No new dependencies | `package.json` not modified |
| No artifact format changes | `src/artifacts/` not touched |
| No NEAT changes | `/Users/sinan/Documents/NEAT WORK/Neat` working tree untouched on `main`; `pistis` branch on NEAT remote still at `78a72db` |
| No PR / GitHub integration | `src/pr/` not modified |
| No CLI changes | `src/cli.ts` not modified; no new flags added |

## Definition of done

| Gate | Status |
|---|---|
| `bun test packages/pistis/test/flash-worker.test.ts` green | ✓ 21/21 |
| Full pistis test suite green | ✓ 132/132 (was 111, +21 new, 0 regressions) |
| `tsgo` typecheck clean | ✓ |
| Audit doc (this file) maps every section | ✓ |
| No `GEMINI_API_KEY` value in test fixtures or assertions | ✓ — `FAKE_KEY` is a clearly placeholder string used only to verify it does NOT appear in URLs/logs |
| No regressions | ✓ verified |

## Findings / drift

**None.** Every spec commitment maps to code + tests. No undocumented additions beyond `redact()` (which is named in the spec as "redacted reason" but the regex itself wasn't specified — auditing as fulfilment of the redaction commitment, not as drift).

One observability item deferred explicitly: cache-hit ratio logging. Not a correctness concern; production observability follow-up.

## Ready for PR

All gates green. Branch `pistis-phase-4a-flash-worker` is ready to push and PR against `pistis-phase-3`.
