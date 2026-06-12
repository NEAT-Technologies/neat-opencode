/**
 * Pistis public surface — the entry point OpenCode's CLI command calls into.
 *
 * Phase 1 is a deterministic dry-run scaffold:
 *   1. Load + normalize incident JSON.
 *   2. Fetch graph context from NEAT (read-only).
 *   3. Classify deterministically.
 *   4. Build a remediation plan.
 *   5. Run risk + policy preflight gates.
 *   6. Dispatch via NoopDispatcher (records intended dispatch).
 *   7. Write final report.
 *
 * Phase 1 NEVER:
 *   - edits files outside the artifact directory,
 *   - runs arbitrary shell commands,
 *   - creates branches/commits/PRs,
 *   - calls a real OpenCode session.
 */

import { loadIncidentFile, normalizeIncident } from "./incident/schema"
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
import { ArtifactStore, resolveArtifactRoot, artifactWriter } from "./artifacts/store"
import { renderFinalReport } from "./report/final-report"

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
  /** For tests: replace fetch + return artifacts even on error. */
  fetchImpl?: typeof fetch
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
}

export async function runPistis(opts: RunPistisOptions): Promise<RunPistisResult> {
  // Phase 1 hard rules.
  if (opts.apply) {
    throw new Error("--apply is not supported in Phase 1; runs are always dry-run")
  }
  if (opts.pr) {
    throw new Error("--pr is a Phase 3 feature and is not supported in Phase 1")
  }
  const dryRun = opts.dryRun !== false // default true in Phase 1

  // 1. Load incident.
  const incident = await loadIncidentFile(opts.incidentPath)

  // 2. Resolve NEAT client + artifact store.
  const baseUrl = resolveNeatBaseUrl(opts.neatUrl)
  const authToken = resolveNeatAuthToken()
  const client = new NeatClient({
    baseUrl,
    authToken,
    project: opts.project ?? incident.project,
    fetchImpl: opts.fetchImpl,
  })
  const store = await ArtifactStore.create(resolveArtifactRoot(opts.outDir), incident.incidentId)

  // 3. Persist the normalized incident immediately so even a fatal NEAT failure
  //    leaves a useful trace.
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
        approveRisk: opts.approveRisk ?? [],
      },
    },
  })

  // 4. Build graph context (throws on /health or primary node failure).
  const graph = await buildGraphContext(client, incident)
  await store.writeJson("graph-context.json", graph)

  // 5. Classify + plan.
  const classification = classifyIncident(incident, graph)
  const plan = buildPlan(incident, graph, classification, {
    testCommands: opts.testCommands ?? [],
  })

  // 6. Risk + policy gates.
  const riskGates = runPreflightRiskGates({
    incident,
    graph,
    classification,
    approvals: opts.approveRisk,
  })
  const policy = await runPolicyGate(client, graph)
  const validation = {
    riskGates,
    riskWorstStatus: worstStatus(riskGates),
    policy,
    plannedTestRuns: planTestRuns(opts.testCommands ?? []),
  }
  await store.writeJson("validation.json", validation)

  // 7. Plan artifact.
  await store.writeText("plan.md", renderPlanMarkdown(incident, graph, plan, renderRiskGatesMarkdown(riskGates)))

  // 8. Dispatch (Phase 1: NoopDispatcher writes dispatch-request.json).
  const dispatcher = new NoopDispatcher(artifactWriter(store))
  const dispatch = await dispatcher.dispatch({
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
      agentEventsJsonl: true,
      sessionTranscript: false,
    },
    dryRun,
  })

  // 9. Final report.
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
    phase: 1,
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
  }
}

// Re-export key types so consumers (OpenCode CLI, future Phase 2 callers) can
// stay loosely coupled to internal modules.
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
export { NoopDispatcher } from "./opencode/dispatcher"
export type {
  RemediationDispatcher,
  RemediationDispatchInput,
  RemediationDispatchResult,
} from "./opencode/dispatcher"
export { ArtifactStore, resolveArtifactRoot, artifactWriter } from "./artifacts/store"
export { renderFinalReport } from "./report/final-report"
