# Phase 4D — Router Worker + Async Reviewer Integration

Wires the real model implementations from Phases 4A, 4B, 4C into the existing `MultiAgentOrchestrator`. Ships a `RouterWorker` that dispatches by role to FlashWorker/MinimaxWorker, an adapter so the orchestrator can use either a sync `ContractReviewer` (RuleBased) or an async one (Kimi), and CLI flags so the user can opt into the real-model stack at run time.

This is the **only Phase 4 PR that touches `MultiAgentOrchestrator`.** All previous PRs were non-integrating. Tight, surgical changes here so the existing 216 tests don't budge.

Audited against this spec before the PR opens.

## Scope

**In**:
- `RouterWorker` in `src/workers/router-worker.ts` — implements `Worker`; dispatches by `contract.agentRole`
- `SyncToAsyncReviewerAdapter` in `src/contract/async-reviewer.ts` — wraps a sync `ContractReviewer` as an `AsyncContractReviewer` so the orchestrator can have a single async code path internally
- Extend `MultiAgentOrchestrator`:
  - Add `asyncReviewer?: AsyncContractReviewer` to options
  - Add `incidentForReview` field (incident + graphContext + primaryNodeId) passed to the reviewer when the async path is taken
  - `runRole()` calls a single internal `getReview()` that returns `Promise<ContractReview>` regardless of which reviewer is configured
  - Existing constructor and existing sync `reviewer` field remain — no breaking change for `MultiRoleStubWorker` + `RuleBasedContractReviewer` callers
- Add CLI flags (`src/cli.ts`):
  - `--use-router` → builds a RouterWorker from FlashWorker + MinimaxWorker
  - `--use-kimi-reviewer` → builds a KimiReviewer wired with the NeatClient and passes it as `asyncReviewer`
  - `--allow-unstub-without-env` → safety: tells Pistis that running without `GEMINI_API_KEY` / `MINIMAX_API_KEY` / `MOONSHOT_API_KEY` should fall back to stubs (default behaviour) vs throwing
- Wire CLI selections through `src/index.ts` so `runPistis()` honours them

**Out**:
- No NEAT changes
- No new tools or models beyond what 4A/4B/4C already shipped
- No best-of-N parallel worker dispatch
- No GitHub PR creation / human approval flow (Phase 5)
- No streaming
- No CLI flags for individual API keys (use env vars; constructors already do this)

## What MUST change in the orchestrator (and what MUST NOT)

| Field / behaviour | Change? |
|---|---|
| `MultiAgentOrchestratorOptions.worker` | Unchanged — still required |
| `MultiAgentOrchestratorOptions.reviewer` | Unchanged — still required, still sync |
| `MultiAgentOrchestratorOptions.asyncReviewer` | NEW — optional |
| `MultiAgentOrchestratorOptions.workspaceCwd` | Unchanged |
| `MultiAgentOrchestratorOptions.writeArtifact` | Unchanged |
| `MultiAgentOrchestratorOptions.allowDirtyWorkspace` | Unchanged |
| `OrchestrationInput` fields | Unchanged |
| `RoleAttemptRecord` | Unchanged |
| `OrchestrationSummary` | Unchanged |
| `runRole()` review call site | CHANGED — single `await getReview(...)` helper |
| `getReview()` | NEW private method |
| Sync reviewer behaviour with sync workers | Unchanged — existing tests pass without modification |

The clean rule: **if `asyncReviewer` is set, use it; otherwise wrap the sync reviewer.** No third configuration path.

## RouterWorker

```ts
class RouterWorker implements Worker {
  readonly name = "router"

  constructor(opts: {
    flashWorker: Worker      // handles graph_context, root_cause, security_risk
    minimaxWorker: Worker    // handles patch, migration
    testRoleNoop?: Worker    // optional; defaults to a built-in no-op
  })

  async run(contract, workspace): Promise<AgentResult> {
    switch (contract.agentRole) {
      case "graph_context":
      case "root_cause":
      case "security_risk":   return this.flashWorker.run(contract, workspace)
      case "patch":
      case "migration":       return this.minimaxWorker.run(contract, workspace)
      case "test":            return testRoleResult(contract)
      case "reviewer":        throw new OutOfRoleError("reviewer", "router")
      default:                return failedResult(contract, `unknown role: ${contract.agentRole}`)
    }
  }
}
```

Notes:
- `test` role is handled by the orchestrator's `runTestCommands()` directly. The worker just returns a synthetic AgentResult declaring the commands to run; the orchestrator overrides `testsRun` and writes the test report. We keep this pattern unchanged.
- `reviewer` role is NEVER dispatched to a Worker. The orchestrator doesn't include a `reviewer` step in any plan from `buildOrchestrationPlan` (verified by reading `plan.ts`). Throwing here is purely defensive — if someone builds a custom plan with a reviewer step, the router complains rather than silently misroute.
- `OutOfRoleError` (from Phase 4A) is reused so callers handle worker-side role mismatches the same way regardless of which worker is in the slot.

## SyncToAsyncReviewerAdapter

```ts
export class SyncToAsyncReviewerAdapter implements AsyncContractReviewer {
  readonly name: string
  constructor(private readonly inner: ContractReviewer) {
    this.name = `async(${inner.name})`
  }
  async review(input: AsyncContractReviewerInput): Promise<ContractReview> {
    return this.inner.review(input)   // AsyncContractReviewerInput extends ContractReviewerInput
  }
}
```

Trivial wrapper — exists so the orchestrator can have a single internal code path that always awaits. Not exposed in the public API beyond the export from `src/contract/async-reviewer.ts`.

## Orchestrator extension

Internal flow inside `runRole()`:

```ts
// before:
const review = this.opts.reviewer.review({ contract, result, testRuns, observedFilesChanged, attempt })

// after:
const review = await this.getReview({ contract, result, testRuns, observedFilesChanged, attempt }, input)
```

`getReview()`:

```ts
private async getReview(
  base: ContractReviewerInput,
  input: OrchestrationInput,
): Promise<ContractReview> {
  const role = base.contract.agentRole
  const isFileWriting = FILE_WRITING_ROLES.has(role as never)
  // KimiReviewer is purpose-built to review diffs and pre-flights on
  // empty AgentResult.diff with needs_human. Routing reasoning roles
  // (graph_context / root_cause / security_risk) to it would force every
  // run to escalate to a human. Use it only where a diff actually exists.
  if (this.opts.asyncReviewer && isFileWriting) {
    return this.opts.asyncReviewer.review({
      ...base,
      incident: input.incident,
      graphContext: input.graph,
      primaryNodeId: input.incident.primaryNodeId,
    })
  }
  return this.opts.reviewer.review(base)
}
```

The role-based routing is **load-bearing**, not a design preference. Without it, every reasoning role's contract review would return `needs_human` because Kimi's diff pre-flight has no diff to look at. With it, the sync rule-based reviewer handles reasoning steps (cheap, deterministic, already trusted) and Kimi handles patch/migration (where its tools and judgment matter).

This preserves the existing sync reviewer path for callers that don't pass `asyncReviewer`, AND for reasoning roles even when both reviewers are provided. No regression.

## CLI changes

New flags on the existing yargs CommandModule:

- `--use-router` (boolean, default false) — Build a RouterWorker. Requires `GEMINI_API_KEY` and `MINIMAX_API_KEY` to be set OR `--allow-unstub-without-env=false` to fall back to the stubs
- `--use-kimi-reviewer` (boolean, default false) — Build a KimiReviewer. Requires `MOONSHOT_API_KEY`
- `--max-tool-calls` (number, optional) — override the Kimi tool budget (also respects `PISTIS_KIMI_TOOL_BUDGET` env)

CLI flag interaction:
- `--use-router` without API keys → throw a clear error pointing at the missing env vars
- `--use-kimi-reviewer` without `MOONSHOT_API_KEY` → throw a clear error
- `--use-router` and `--use-kimi-reviewer` are independent; you can mix-and-match (router with stub reviewer, stub worker with Kimi reviewer)
- Neither flag → existing behaviour (stub worker + RuleBased reviewer)

## `runPistis()` wiring

`src/index.ts` accepts `useRouter?: boolean` and `useKimiReviewer?: boolean` in `RunPistisOptions`. When set:

```ts
let worker: Worker = stubWorker
if (opts.useRouter) {
  const flashWorker = new FlashWorker()         // throws if GEMINI_API_KEY missing
  const minimaxWorker = new MinimaxWorker()     // throws if MINIMAX_API_KEY missing
  worker = new RouterWorker({ flashWorker, minimaxWorker })
}

let asyncReviewer: AsyncContractReviewer | undefined
if (opts.useKimiReviewer) {
  asyncReviewer = new KimiReviewer({
    neatClient,                                  // existing
    appendToolCallLog: makeToolCallLogAppender(artifactStore),
  })
}

const orch = new MultiAgentOrchestrator({
  worker,
  reviewer: ruleBasedReviewer,                   // sync, kept as fallback
  asyncReviewer,
  workspaceCwd, writeArtifact, ...
})
```

`makeToolCallLogAppender()` creates a closure that appends each line to `<runDir>/tool-calls.jsonl` via `artifactStore.writeText`. Helper lives in `src/index.ts`.

## File layout

```
packages/pistis/src/workers/
  router-worker.ts          # NEW

packages/pistis/src/contract/
  async-reviewer.ts         # EXTENDED — adds SyncToAsyncReviewerAdapter alongside the interface

packages/pistis/src/orchestration/
  orchestrator.ts           # MODIFIED — adds asyncReviewer option, getReview helper

packages/pistis/src/cli.ts  # MODIFIED — adds --use-router, --use-kimi-reviewer, --max-tool-calls
packages/pistis/src/index.ts # MODIFIED — wires CLI flags through to orchestrator constructor

packages/pistis/test/
  router-worker.test.ts                   # NEW
  orchestrator-async-reviewer.test.ts     # NEW
```

Re-exports in `src/workers/index.ts` add `RouterWorker`. `src/contract/async-reviewer.ts` adds `SyncToAsyncReviewerAdapter` export.

## Test plan

1. RouterWorker `graph_context` → FlashWorker.run called; MinimaxWorker.run not called.
2. RouterWorker `root_cause` → FlashWorker.
3. RouterWorker `security_risk` → FlashWorker.
4. RouterWorker `patch` → MinimaxWorker; Flash not called.
5. RouterWorker `migration` → MinimaxWorker.
6. RouterWorker `test` → returns synthetic AgentResult declaring validation commands; neither sub-worker is called.
7. RouterWorker `reviewer` → throws OutOfRoleError; neither sub-worker called.
8. RouterWorker `unknown_role` → returns `failed` AgentResult with a clear summary.
9. Orchestrator with `asyncReviewer` set → orchestrator calls `asyncReviewer.review` and ignores the sync reviewer field.
10. Orchestrator without `asyncReviewer` → existing behaviour, sync reviewer used.
11. Orchestrator with `asyncReviewer` produces an OrchestrationSummary identical in structure to the sync case (no schema drift).
12. Orchestrator with `asyncReviewer` propagates `incident`, `graphContext`, `primaryNodeId` into the reviewer's input (verified by inspecting a recorded reviewer call).
13. SyncToAsyncReviewerAdapter.review returns the same value as inner.review on a sample input.
14. Full e2e: stub Gemini + MiniMax + Moonshot fetches, run a `runtime_exception` incident end-to-end with `useRouter: true, useKimiReviewer: true`. Final verdict matches the stub's wired outcome.
15. CLI: `--use-router` flag is registered and yargs parses it.
16. CLI: `--use-kimi-reviewer` flag is registered.
17. Backwards compat: every existing test (216) still passes unchanged.
18. Orchestrator with `asyncReviewer` on a `graph_context` step → sync reviewer used (not Kimi), because graph_context is not a file-writing role. Verified by asserting the async reviewer's `review()` was NOT called for that step.
19. Orchestrator with `asyncReviewer` on a `patch` step → async reviewer used. Verified by asserting `review()` WAS called for that step.

## Out of scope, explicitly

- No changes to `RuleBasedContractReviewer`, `NeatClient`, `MultiRoleStubWorker`, `StubWorker`, or any Phase 4A/B/C internals
- No NEAT-side modifications
- No new artifact format
- No PR creation / push / GitHub anything
- No streaming or concurrency

## Definition of done

- `bun test packages/pistis/test/router-worker.test.ts` green
- `bun test packages/pistis/test/orchestrator-async-reviewer.test.ts` green
- All existing tests still pass — full pistis suite green
- `tsgo --noEmit` clean across all 24 workspace packages
- Audit doc maps every spec section to code or test
- CLI flags work in `bun run src/index.ts --use-router --use-kimi-reviewer --help`
