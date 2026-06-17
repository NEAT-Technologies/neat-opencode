/**
 * Pistis public surface — the entry point OpenCode's CLI command calls into.
 *
 * Phase 1 (dry-run): plan + gate + NoopDispatcher writes the first AgentContract.
 * Phase 2 (--apply): plan + gate + OpenCodeSessionDispatcher runs ONE worker,
 *                    reviews against successCriteria, retries with refined prompt.
 *
 * Pistis NEVER:
 *   - auto-merges
 *   - deploys to production
 *   - calls --pr (that's Phase 4)
 *   - modifies files outside `--workspace` and the artifact dir
 *   - runs shell commands the user didn't explicitly list in --test-command
 */

import { loadIncidentFile } from "./incident/schema"
import {
  NeatClient,
  resolveNeatBaseUrl,
  resolveNeatAuthToken,
  redactToken,
} from "./neat/client"
import { buildGraphContext } from "./neat/context-builder"
import { classifyIncident } from "./planner/classifier"
import { buildPlan, renderPlanMarkdown } from "./planner/remediation-plan"
import { runPreflightRiskGates, renderRiskGatesMarkdown, worstStatus } from "./validation/risk-gate"
import { runPolicyGate } from "./validation/policy-gate"
import { planTestRuns } from "./validation/test-runner"
import { NoopDispatcher, buildSafetyRules } from "./opencode/dispatcher"
import { OpenCodeSessionDispatcher } from "./opencode/opencode-session-dispatcher"
import { StubWorker } from "./opencode/stub-worker"
import { OpenCodeWorker } from "./opencode/opencode-worker"
import { MultiRoleStubWorker } from "./orchestration/role-worker"
import { MultiAgentOrchestrator } from "./orchestration/orchestrator"
import { buildOrchestrationPlan } from "./orchestration/plan"
import type { Worker } from "./opencode/worker"
import { RuleBasedContractReviewer } from "./contract/reviewer"
import type { ContractReviewer } from "./contract/reviewer"
import type { AsyncContractReviewer } from "./contract/async-reviewer"
import { FlashWorker } from "./workers/flash-worker"
import { MinimaxWorker } from "./workers/minimax-worker"
import { RouterWorker } from "./workers/router-worker"
import { KimiReviewer } from "./reviewers/kimi-reviewer"
import { ArtifactStore, resolveArtifactRoot, artifactWriter } from "./artifacts/store"
import { renderFinalReport } from "./report/final-report"

export type WorkerKind = "stub" | "opencode" | "multi-role-stub"

export interface RunPistisOptions {
  incidentPath: string
  neatUrl?: string
  project?: string
  testCommands?: string[]
  outDir?: string
  dryRun?: boolean
  apply?: boolean
  pr?: boolean
  approveRisk?: string[]
  /** Phase 2 worker selector. Default: "stub". */
  worker?: WorkerKind
  /** Phase 2 workspace where the worker operates. Required for --apply. */
  workspace?: string
  /** Phase 2: skip the clean-working-tree precheck (developer convenience). */
  allowDirtyWorkspace?: boolean
  /** Phase 2: skip the git-repo precheck (StubWorker on plain dirs). */
  allowNonGitWorkspace?: boolean
  /** Phase 2: cap contract retries. Default 2 (so 3 attempts total). */
  maxRetries?: number
  /** Phase 3: switch to multi-agent orchestration (multiple roles per incident). */
  multiAgent?: boolean
  /** Phase 4D: compose FlashWorker + MinimaxWorker via RouterWorker. */
  useRouter?: boolean
  /** Phase 4D: use KimiReviewer (Moonshot K2.7) for file-writing role review. */
  useKimiReviewer?: boolean
  /** Phase 4D: override KimiReviewer iteration cap. */
  maxToolCalls?: number
  /** For tests. */
  fetchImpl?: typeof fetch
  workerImpl?: Worker
  reviewerImpl?: ContractReviewer
  asyncReviewerImpl?: AsyncContractReviewer
}

export interface RunPistisResult {
  incidentId: string
  runDir: string
  artifacts: string[]
  classification: string
  worstRiskStatus: string
  policyStatus: string
  dispatched: boolean
  dryRun: boolean
  /** Phase 2: dispatcher's reason / verdict. */
  dispatchReason?: string
}

export async function runPistis(opts: RunPistisOptions): Promise<RunPistisResult> {
  if (opts.pr) {
    throw new Error("--pr is a Phase 4 feature and is not supported yet")
  }
  const apply = opts.apply === true
  const dryRun = apply ? false : opts.dryRun !== false

  const incident = await loadIncidentFile(opts.incidentPath)
  const baseUrl = resolveNeatBaseUrl(opts.neatUrl)
  const authToken = resolveNeatAuthToken()
  const client = new NeatClient({
    baseUrl,
    authToken,
    project: opts.project ?? incident.project,
    fetchImpl: opts.fetchImpl,
  })
  const store = await ArtifactStore.create(resolveArtifactRoot(opts.outDir), incident.incidentId)

  await store.writeJson("incident.json", {
    normalized: incident,
    pistis: {
      neatBaseUrl: baseUrl,
      neatProject: opts.project ?? incident.project,
      neatAuthToken: redactToken(authToken),
      cliFlags: {
        incidentPath: opts.incidentPath,
        testCommands: opts.testCommands ?? [],
        outDir: opts.outDir,
        dryRun,
        apply,
        approveRisk: opts.approveRisk ?? [],
        worker: opts.worker ?? "stub",
        workspace: opts.workspace,
        maxRetries: opts.maxRetries,
        multiAgent: opts.multiAgent === true,
      },
    },
  })

  const graph = await buildGraphContext(client, incident)
  await store.writeJson("graph-context.json", graph)

  const classification = classifyIncident(incident, graph)
  const plan = buildPlan(incident, graph, classification, {
    testCommands: opts.testCommands ?? [],
  })

  const riskGates = runPreflightRiskGates({
    incident,
    graph,
    classification,
    approvals: opts.approveRisk,
    applyMode: apply,
  })
  const policy = await runPolicyGate(client, graph)
  const validation = {
    riskGates,
    riskWorstStatus: worstStatus(riskGates),
    policy,
    plannedTestRuns: planTestRuns(opts.testCommands ?? [], apply ? "executed by dispatcher" : "phase 1 dry run"),
  }
  await store.writeJson("validation.json", validation)
  await store.writeText("plan.md", renderPlanMarkdown(incident, graph, plan, renderRiskGatesMarkdown(riskGates)))

  const hasBlockingGate =
    riskGates.some((g) => g.status === "block" || g.status === "requires_approval") ||
    policy.status === "block"

  const dispatchInput = {
    incident,
    graphContext: graph,
    plan,
    candidateFiles: incident.candidateFiles,
    constraints: {
      timeoutMs: 5 * 60 * 1000,
      maxFiles: 25,
      testCommands: opts.testCommands ?? [],
    },
    safetyRules: buildSafetyRules(riskGates, policy),
    requestedOutputs: {
      patchDiff: true,
      agentEventsJsonl: false,
      sessionTranscript: false,
    },
    dryRun,
    riskGates,
  }

  let dispatch
  if (apply && !hasBlockingGate) {
    if (!opts.workspace) {
      throw new Error("pistis: --apply requires --workspace pointing at a (clean) git repo")
    }
    const reviewer = opts.reviewerImpl ?? new RuleBasedContractReviewer()
    if (opts.multiAgent === true) {
      // Phase 3 path: multi-agent orchestrator.
      const worker = opts.workerImpl ?? buildRealOrStubWorker(opts)
      const asyncReviewer = opts.asyncReviewerImpl ?? buildKimiReviewerIfRequested(opts, client, store)
      const orchPlan = buildOrchestrationPlan(classification)
      const orchestrator = new MultiAgentOrchestrator({
        worker,
        reviewer,
        asyncReviewer,
        workspaceCwd: opts.workspace,
        allowDirtyWorkspace: opts.allowDirtyWorkspace,
        allowNonGitWorkspace: opts.allowNonGitWorkspace,
        writeArtifact: artifactWriter(store),
        maxRetries: opts.maxRetries,
      })
      const orchSummary = await orchestrator.run({
        incident,
        graph,
        plan,
        classification,
        riskGates,
        testCommands: opts.testCommands ?? [],
        orchestrationPlan: orchPlan,
      })
      dispatch = {
        dispatched: orchSummary.finalVerdict === "accepted",
        reason: `multi-agent: ${orchSummary.totalAttempts} attempt(s) across ${orchPlan.steps.length} role(s); final verdict=${orchSummary.finalVerdict}`,
        dispatchedAt: new Date().toISOString(),
      }
    } else {
      // Phase 2 path: single OpenCodeSessionDispatcher.
      const worker = opts.workerImpl ?? pickWorker(opts.worker ?? "stub")
      const dispatcher = new OpenCodeSessionDispatcher({
        worker,
        reviewer,
        workspaceCwd: opts.workspace,
        allowDirtyWorkspace: opts.allowDirtyWorkspace,
        allowNonGitWorkspace: opts.allowNonGitWorkspace,
        writeArtifact: artifactWriter(store),
      })
      dispatch = await dispatcher.dispatch(dispatchInput)
    }
  } else {
    const dispatcher = new NoopDispatcher(artifactWriter(store))
    dispatch = await dispatcher.dispatch(dispatchInput)
    if (apply && hasBlockingGate) {
      dispatch = { ...dispatch, reason: "blocked by preflight gate — dispatching as noop instead of worker" }
    }
  }

  const artifacts = await store.list()
  const report = renderFinalReport({
    incident,
    graph,
    classification,
    plan,
    riskGates,
    policy,
    dispatch,
    artifactsWritten: artifacts,
    runDir: store.runDir,
    dryRun,
    phase: apply ? 2 : 1,
  })
  await store.writeText("final-report.md", report)

  const finalArtifacts = await store.list()
  return {
    incidentId: incident.incidentId,
    runDir: store.runDir,
    artifacts: finalArtifacts,
    classification: classification.class,
    worstRiskStatus: worstStatus(riskGates),
    policyStatus: policy.status,
    dispatched: dispatch.dispatched,
    dryRun,
    dispatchReason: dispatch.reason,
  }
}

function pickWorker(kind: WorkerKind): Worker {
  switch (kind) {
    case "opencode":         return new OpenCodeWorker()
    case "stub":             return new StubWorker()
    case "multi-role-stub":  return new MultiRoleStubWorker()
  }
}

/**
 * Phase 4D: build the RouterWorker if --use-router was set; otherwise fall
 * back to the configured stub worker. FlashWorker / MinimaxWorker constructors
 * throw clearly on missing API keys, so missing-env errors surface here with
 * a clean message rather than later in a confusing place.
 */
function buildRealOrStubWorker(opts: RunPistisOptions): Worker {
  if (opts.useRouter !== true) {
    return pickWorker(opts.worker ?? "multi-role-stub")
  }
  const flashWorker = new FlashWorker()
  const minimaxWorker = new MinimaxWorker()
  return new RouterWorker({ flashWorker, minimaxWorker })
}

/**
 * Phase 4D: build a KimiReviewer when --use-kimi-reviewer was set. Returns
 * undefined when the flag is not set; the orchestrator falls back to the
 * sync rule-based reviewer in that case.
 *
 * Tool-call audit log is wired into `tool-calls.jsonl` under the run dir
 * via ArtifactStore.
 */
function buildKimiReviewerIfRequested(
  opts: RunPistisOptions,
  client: NeatClient,
  store: ArtifactStore,
): AsyncContractReviewer | undefined {
  if (opts.useKimiReviewer !== true) return undefined
  const append = makeToolCallLogAppender(store)
  return new KimiReviewer({
    neatClient: client,
    appendToolCallLog: append,
    maxToolCalls: opts.maxToolCalls,
  })
}

/**
 * Returns a closure that appends one line at a time to tool-calls.jsonl
 * under the run dir. The lines are accumulated in memory and re-written
 * each call — fine for the per-incident scale (max ~8 calls) and avoids
 * needing a streaming file handle through ArtifactStore.
 */
function makeToolCallLogAppender(store: ArtifactStore): (line: string) => Promise<void> {
  let accumulated = ""
  return async (line: string) => {
    accumulated += line
    await store.writeText("tool-calls.jsonl", accumulated)
  }
}

// Re-exports: keep consumers loosely coupled.
export { normalizeIncident, loadIncidentFile } from "./incident/schema"
export type { NormalizedIncident } from "./incident/schema"
export { NeatClient, resolveNeatBaseUrl, resolveNeatAuthToken } from "./neat/client"
export type { GraphContext } from "./neat/context-builder"
export { classifyIncident } from "./planner/classifier"
export type { Classification, IssueClass } from "./planner/classifier"
export { buildPlan, renderPlanMarkdown } from "./planner/remediation-plan"
export type { RemediationPlan } from "./planner/remediation-plan"
export { runPreflightRiskGates, renderRiskGatesMarkdown, worstStatus } from "./validation/risk-gate"
export type { GateResult, GateStatus } from "./validation/risk-gate"
export { runPolicyGate } from "./validation/policy-gate"
export type { PolicyGateResult, PolicyGateStatus } from "./validation/policy-gate"
export { runTestCommands, planTestRuns, renderTestReport } from "./validation/test-runner"
export type { TestRunResult } from "./validation/test-runner"
export { NoopDispatcher, buildSafetyRules } from "./opencode/dispatcher"
export type {
  RemediationDispatcher,
  RemediationDispatchInput,
  RemediationDispatchResult,
} from "./opencode/dispatcher"
export { OpenCodeSessionDispatcher } from "./opencode/opencode-session-dispatcher"
export { StubWorker } from "./opencode/stub-worker"
export { OpenCodeWorker } from "./opencode/opencode-worker"
export type { Worker, WorkerWorkspace } from "./opencode/worker"
export { WorkerNotImplementedError } from "./opencode/worker"
export { RuleBasedContractReviewer } from "./contract/reviewer"
export type { ContractReviewer, ContractReviewerInput } from "./contract/reviewer"
export { buildAgentContract } from "./contract/builder"
export type { AgentContract, AgentResult, ContractReview, CriterionResult } from "./contract/types"
export { probeGit, captureDiff } from "./opencode/git-diff"
export { ArtifactStore, resolveArtifactRoot, artifactWriter } from "./artifacts/store"
export { renderFinalReport } from "./report/final-report"
export { RouterWorker } from "./workers/router-worker"
export { SyncToAsyncReviewerAdapter } from "./contract/async-reviewer"
export type { AsyncContractReviewer, AsyncContractReviewerInput } from "./contract/async-reviewer"
export { PistisDaemon, RunRegistry, validateArtifactPath, contentTypeFor, deliverWebhook, buildResult, summariseToolCalls } from "./daemon"
export type { PistisDaemonOptions, RunRecord, RunStatus, WebhookConfig, ResultSinkInput } from "./daemon"
export { buildOrchestrationPlan } from "./orchestration/plan"
export type { OrchestrationPlan, OrchestrationStep } from "./orchestration/plan"
export { MultiAgentOrchestrator } from "./orchestration/orchestrator"
export type {
  MultiAgentOrchestratorOptions,
  OrchestrationInput,
  OrchestrationSummary,
  RoleAttemptRecord,
} from "./orchestration/orchestrator"
export { MultiRoleStubWorker } from "./orchestration/role-worker"
export { buildRoleContract } from "./orchestration/role-contract-builders"
export type { AgentRole } from "./orchestration/roles"
export { FILE_WRITING_ROLES } from "./orchestration/roles"
