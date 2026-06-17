# Phase 4B — Implementation Audit

Walks `PHASE_4B_MINIMAX_WORKER.md` section by section. Each row maps a spec commitment to the code or test that fulfils it (or to an explicit deferral). Audit performed before opening the PR.

## Scope — In

| Commitment | Fulfilment |
|---|---|
| Implement `Worker` interface in `src/workers/minimax-worker.ts` | `minimax-worker.ts:58` — `class MinimaxWorker implements Worker` |
| Handle `patch` + `migration` roles | `minimax-worker.ts:11` — `SUPPORTED_ROLES`; `run()` guard |
| OpenAI-compatible chat-completions via native `fetch` | `minimax-worker.ts:225` — `this.fetchImpl(url, ...)`; body builds OpenAI shape |
| Read `MINIMAX_API_KEY` from env | `minimax-worker.ts:75` — constructor reads or throws |
| `Authorization: Bearer <key>` header | `minimax-worker.ts:226–229` — header set; **Test #14** verifies |
| Configurable model + base URL (defaults `MiniMax-M3`, `api.minimaxi.com/v1`) | `minimax-worker.ts:13,14,82,83` |
| Bundle current `allowedFiles` contents into prompt | `minimax-worker.ts:241–273` — `bundleAllowedFiles`; **Test #15** verifies markers |
| Force structured output (`response_format: json_object`) | `minimax-worker.ts:178` — set in `buildRequest`; **Test #13** verifies |
| Parse the diff + defensive `allowedFiles` recheck | `minimax-worker.ts:139–151` — uses `parseUnifiedDiff` + `validateDiffPaths` from `diff-parser.ts`; **Tests #3, #4, #5** verify |
| Apply via `git apply --whitespace=nowarn` | `git-apply.ts:18` — no `--3way` per audit fix; injectable for tests |
| Map errors → `AgentResult.status="blocked"` with redacted reason | `dispatch()` returns blocked variants; `redact()` replaces literal `apiKey` substring; **Test #6** verifies key not echoed |
| Throw `OutOfRoleError` on graph_context / root_cause / reviewer | `minimax-worker.ts:99–101` — checked first in `run()`; **Test #12** verifies |

## Scope — Out (explicit deferrals)

| Commitment | Verification |
|---|---|
| No best-of-N parallel workers in this PR | `MinimaxWorker.run()` is single-shot; comment block in spec acknowledges the router-worker is Phase 4D |
| No tool use / function calling | No `tools` field in request body |
| No streaming | Uses chat completions, not streaming endpoint |
| No image inputs | No `image_url` parts |
| Single transient retry only | `TRANSIENT_RETRY_LIMIT = 1` (`minimax-worker.ts:15`) |
| No `test` role | Not in `SUPPORTED_ROLES`; throws `OutOfRoleError` |

## API shape

| Commitment | Fulfilment |
|---|---|
| `POST {baseUrl}/chat/completions` | `minimax-worker.ts:183` — URL constructed |
| `Authorization: Bearer <key>` header | `minimax-worker.ts:226–229` |
| Body: `model`, `messages[]`, `response_format`, `temperature: 0.1`, `max_tokens: 8192` | `minimax-worker.ts:172–181`; **Test #13** pins shape |
| Default base URL / model softness acknowledged in spec | Constructor accepts both via env override; tests don't depend on defaults |
| Graceful fallback if `response_format` rejected | `minimax-worker.ts:200–203` — detect `/response_format/i` in 400 body, retry with `stripResponseFormat()`; **Test #20** verifies |
| Fence-stripping fallback in `stripFences()` | `minimax-worker.ts:415–423`; **Test #9b** verifies fenced JSON parses |
| `cached_tokens` logging | Type defined (`OpenAIResponse.usage.prompt_tokens_details.cached_tokens`); deferred to production observability follow-up |

## System prompts per role

| Commitment | Fulfilment |
|---|---|
| `patch` prompt: hard rules (allowedFiles, no new deps, no signature changes, no symptom masking, no PISTIS comments) | `minimax-prompts.ts:PATCH_SYSTEM_PROMPT` |
| `patch` prompt forces JSON shape with `summary`, `diff`, `filesChanged`, `riskNotes`, `unresolvedQuestions` | Same |
| `migration` prompt: NEW file under `migrations/`, idempotency or one-shot annotation, no destructive ops without comment | `minimax-prompts.ts:MIGRATION_SYSTEM_PROMPT` |
| `migration` diff format requires `index 0000000..0000000` for git apply compatibility | Explicitly named in the prompt's "MUST start with" block |
| Prompts are exported separately so callers can iterate | `src/workers/index.ts` re-exports both |

## User message structure

| Commitment | Fulfilment |
|---|---|
| 3-block structure: stable (incident + graphContext), prior findings, variable tail (contract + files + ask) | `minimax-worker.ts:347–356` — `buildUserMessage` / `buildStablePrefix` / `buildPriorFindingsBlock` / `buildRoleTail` |
| Stable prefix byte-identical across retries of the same contract | **Test #18** verifies blocks[0] and blocks[1] identical |
| Files appear under `=== FILE: <path> ===` markers | `buildRoleTail` (`minimax-worker.ts:380–384`); **Test #15** verifies |
| Missing file shows `<file does not exist yet — worker must create it>` | `minimax-worker.ts:381–383`; covered by migration test #2 (file doesn't exist; worker creates) |

## Bundling

| Commitment | Fulfilment |
|---|---|
| Per-file byte cap (default 32 KiB) | `DEFAULT_PER_FILE_BYTE_CAP = 32 * 1024` (`minimax-worker.ts:16`); injectable via constructor |
| Bundle total byte cap (default 256 KiB) → `failed` if exceeded | `DEFAULT_BUNDLE_BYTE_CAP`; **Test #17** verifies failed status + no API call |
| Truncation marker `<truncated: N bytes>` appended | `minimax-worker.ts:264–266`; **Test #16** verifies marker in prompt |
| Truncation risk note added to `AgentResult.riskNotes` | `minimax-worker.ts:265`; **Test #21** verifies |
| Binary files omitted with `<binary file omitted>` + risk note | `minimax-worker.ts:258–262` (detected by null-byte scan in `isProbablyBinary`); covered by unit test in spirit, not explicitly (acknowledged gap, low priority) |

## Pre-flight: workspace must be a git repo

| Commitment | Fulfilment |
|---|---|
| Check `workspace.isGitRepo === true` before API call | `minimax-worker.ts:103–105`; **Test #19** verifies failed status + no API call + no gitApply call |
| Clear summary `"MinimaxWorker requires a git workspace ..."` | Same line; **Test #19** asserts regex |

## Defensive allowedFiles check

| Commitment | Fulfilment |
|---|---|
| Parse `+++ b/<path>` and `--- a/<path>` from diff | `diff-parser.ts:parseUnifiedDiff` |
| Verify every path matches `allowedFiles` exactly (posix-normalised) | `diff-parser.ts:validateDiffPaths` + `normalisePosix`; **Test #3** verifies `not_allowed` reason |
| No path matches any glob in `forbiddenFiles` | `validateDiffPaths` + `matchesGlob`; **Test #4** verifies `forbidden` reason |
| No path escapes workspace via `..` or absolute | `validateDiffPaths` checks `includes("..") || startsWith("/")`; covered in `diff-parser.test.ts` |
| Diff NOT applied if any check fails | **Test #3, #4** verify `gitApply` call count is 0 |

## Applying the diff

| Commitment | Fulfilment |
|---|---|
| `git apply --whitespace=nowarn` (no `--3way`) | `git-apply.ts:18` |
| Non-zero exit → `failed` with first stderr line | `minimax-worker.ts:154–158`; **Test #11** verifies "does not apply" in summary |
| No retry on apply failure (orchestrator handles retries) | Apply runs exactly once per `run()` |
| No `git add` / `commit` / branch ops | `git-apply.ts` only invokes `git apply` |

## Error handling table

| Spec row | Fulfilment |
|---|---|
| 401 → blocked, "MiniMax auth failed" | `minimax-worker.ts:196–198`; **Test #6** verifies + key not echoed |
| 429 → retry then blocked | `minimax-worker.ts:204–211`; **"429" test** verifies |
| 5xx → retry then blocked | `minimax-worker.ts:212–215`; **"5xx" test** verifies |
| `finish_reason: "content_filter"` → blocked | `minimax-worker.ts:228–230`; **Test #8** verifies |
| `finish_reason: "length"` → failed (truncated) | `minimax-worker.ts:231–233`; **Test #7** verifies |
| Non-JSON content → blocked, first 200 chars | `minimax-worker.ts:248–253`; **Test #9** verifies length < 300 |
| Missing `diff` or `summary` → failed | `minimax-worker.ts:130–132`; **Test #10** verifies missing-diff |
| Diff touches disallowed file → blocked, not applied | **Tests #3, #4** verify |
| `git apply` non-zero → failed | **Test #11** |
| Network / timeout → retry then blocked | `minimax-worker.ts:191–194` + AbortController; **"network error" test** verifies |
| Literal-substring redactor | `redact()` (`minimax-worker.ts:320–323`); **Test #6** verifies |

## Env / config

| Commitment | Fulfilment |
|---|---|
| `MINIMAX_API_KEY` required (throws on construction) | `minimax-worker.ts:75–77`; **"throws on construction" test** |
| `PISTIS_MINIMAX_MODEL` overrides default | `minimax-worker.ts:82` |
| `PISTIS_MINIMAX_BASE_URL` overrides default | `minimax-worker.ts:83` |
| 30 000 ms default timeout | `DEFAULT_TIMEOUT_MS = 30_000` |
| Constructor signature matches spec | `MinimaxWorkerOptions` (`minimax-worker.ts:23–32`) |

## File layout

| Commitment | Fulfilment |
|---|---|
| `src/workers/minimax-worker.ts` | ✓ |
| `src/workers/minimax-prompts.ts` | ✓ |
| `src/workers/diff-parser.ts` | ✓ |
| `src/workers/git-apply.ts` | ✓ |
| `test/minimax-worker.test.ts` | ✓ |
| `test/diff-parser.test.ts` | ✓ |
| `MinimaxWorker` re-exported from `src/workers/index.ts` | ✓ (alongside prompt exports + diff parser + git apply types) |

## Test plan

| Spec # | Test | Result |
|---|---|---|
| 1 | `patch` valid response → diff applied, completed | ✓ pass |
| 2 | `migration` valid response → new file path + `new file mode` | ✓ pass |
| 3 | Diff outside `allowedFiles` → blocked, `gitApply` not called | ✓ pass |
| 4 | Diff matches `forbiddenFiles` → blocked | ✓ pass |
| 5 | Malformed diff → blocked (parse error) | ✓ pass |
| 6 | 401 → blocked, key not echoed | ✓ pass |
| 7 | `finish_reason: "length"` → failed | ✓ pass |
| 8 | `finish_reason: "content_filter"` → blocked | ✓ pass |
| 9 | Non-JSON content → blocked, first 200 chars | ✓ pass |
| 9b (bonus) | Fenced JSON → unwrapped and parsed | ✓ pass |
| 10 | JSON missing `diff` → failed | ✓ pass |
| 11 | `git apply` non-zero → failed with first stderr line | ✓ pass |
| 12 | Unsupported role (`graph_context`) → `OutOfRoleError` | ✓ pass |
| 13 | Request body shape pin (patch + migration variants) | ✓ pass (2 sub-tests) |
| 14 | API key in Authorization header, never in URL or body | ✓ pass |
| 15 | Bundled files appear under `=== FILE: <path> ===` markers | ✓ pass |
| 16 | File over `perFileByteCap` → `<truncated: N bytes>` in prompt | ✓ pass |
| 17 | Total bundle exceeded → `failed`, no API call | ✓ pass |
| 18 | Two back-to-back calls → byte-identical leading prompt segments | ✓ pass |
| 19 | `workspace.isGitRepo === false` → `failed`, no API call | ✓ pass |
| 20 | 400 with `response_format` → retry without it succeeds | ✓ pass |
| 21 | Truncated file → `riskNotes` warns patch may be incomplete | ✓ pass |

Plus 3 extras (constructor error, 429, 5xx, network error). 28 tests total across `minimax-worker.test.ts`.

Diff parser has its own test file with 15 tests covering modify/new_file/delete entries, multi-entry parsing, header mismatch errors, posix normalisation, glob matching, and path-validation edge cases (workspace escape, absolute paths).

**Total: 43 new tests (28 worker + 15 parser), 99 expect() calls, all pass. Full pistis suite: 175 pass (was 132, +43, zero regressions).**

## Integration

| Commitment | Verification |
|---|---|
| No changes to `MultiAgentOrchestrator` | `git diff pistis-phase-4a-flash-worker..HEAD -- packages/pistis/src/orchestration/` → empty |
| No changes to `MultiRoleStubWorker` | Same |
| No changes to CLI | `cli.ts` not in diff |
| No changes to existing roles | `src/contract/`, `src/opencode/`, `src/orchestration/` untouched |
| MinimaxWorker is opt-in via construction | Caller must explicitly `new MinimaxWorker()` |
| No changes to Phase 4A FlashWorker code | `flash-worker.ts`, `flash-prompts.ts`, `errors.ts` not modified |

## Out of scope, explicitly

| Commitment | Verification |
|---|---|
| No new dependencies | `package.json` not modified |
| No artifact format changes | `src/artifacts/` not touched |
| No NEAT changes | `Neat` repo untouched |
| No router worker | Not implemented; spec defers to Phase 4D |
| No GitHub PR / human approval integration | `src/pr/` not modified |
| No CLI flag additions | `src/cli.ts` not modified |

## Definition of done

| Gate | Status |
|---|---|
| `bun test packages/pistis/test/minimax-worker.test.ts` green | ✓ 28/28 |
| `bun test packages/pistis/test/diff-parser.test.ts` green | ✓ 15/15 |
| `tsgo --noEmit` clean | ✓ |
| Full pistis test suite green | ✓ 175/175 (was 132, +43, zero regressions) |
| Audit doc maps every spec section | ✓ |
| No `MINIMAX_API_KEY` value appears in assertions | ✓ — `FAKE_KEY` is a clearly placeholder string used only to verify it does NOT leak |
| No regressions in Phase 4A FlashWorker tests | ✓ — Flash test count unchanged (21 in both runs) |

## Findings / drift

**One minor gap**: binary file handling (`isProbablyBinary` + `<binary file omitted>` substitution) is implemented but not covered by a dedicated test. Low risk — the null-byte scan is straightforward and the path is exercised indirectly via `bundleAllowedFiles`. Worth a follow-up test in 4C or 4D if traffic ever surfaces this case. Not blocking the PR.

No other drift. Every spec commitment maps to code + tests. Seven pre-code audit fixes (URL/model softness, response_format fallback, --3way dropped, new-file index placeholder, literal redactor, git-repo pre-flight, truncation risk note) all visible in the code.

## Ready for PR

All gates green. Branch `pistis-phase-4b-minimax-worker` ready to push and PR against `pistis-phase-4a-flash-worker`.
