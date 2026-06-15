import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { Classification } from "../planner/classifier"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { GateResult } from "../validation/risk-gate"
import { worstStatus, renderRiskGatesMarkdown } from "../validation/risk-gate"
import type { PolicyGateResult } from "../validation/policy-gate"
import type { RemediationDispatchResult } from "../opencode/dispatcher"

export interface FinalReportInput {
  incident: NormalizedIncident
  graph: GraphContext
  classification: Classification
  plan: RemediationPlan
  riskGates: GateResult[]
  policy: PolicyGateResult
  dispatch: RemediationDispatchResult
  artifactsWritten: string[]
  runDir: string
  dryRun: boolean
  phase: number
}

export function renderFinalReport(input: FinalReportInput): string {
  const {
    incident,
    graph,
    classification,
    plan,
    riskGates,
    policy,
    dispatch,
    artifactsWritten,
    runDir,
    dryRun,
    phase,
  } = input

  const worst = worstStatus(riskGates)
  const lines: string[] = []

  lines.push(`# Pistis Final Report — ${incident.incidentId}`)
  lines.push("")
  lines.push(`> Phase ${phase} ${dryRun ? "(dry run)" : ""}. ${dryRun ? "No files were modified." : ""}`)
  lines.push("")

  lines.push("## Incident")
  lines.push("")
  lines.push(`- **id:** ${incident.incidentId}`)
  lines.push(`- **issue class:** ${classification.class} (${classification.confidence} confidence)`)
  lines.push(`- **severity:** ${incident.severity}`)
  lines.push(`- **primary node:** \`${incident.primaryNodeId}\``)
  if (incident.failingEdgeId) lines.push(`- **failing edge id:** ${incident.failingEdgeId}`)
  if (incident.errorId) lines.push(`- **error id:** ${incident.errorId}`)
  if (incident.message) lines.push(`- **message:** ${truncate(incident.message, 400)}`)
  lines.push("")

  lines.push("## NEAT")
  lines.push("")
  lines.push(`- base URL: \`${graph.neat.baseUrl}\``)
  if (graph.neat.project) lines.push(`- project: \`${graph.neat.project}\``)
  lines.push(`- health: ${graph.neat.healthOk ? "ok" : "FAILED"}`)
  lines.push(`- primary node fetched: ${graph.primaryNode.fetched ? "yes" : "no"}`)
  lines.push("")

  lines.push("## Graph context summary")
  lines.push("")
  for (const [name, sec] of Object.entries(graph.sections)) {
    if (sec.status === "ok") lines.push(`- ${name}: ok (\`${sec.endpoint}\`)`)
    else if (sec.status === "unavailable") lines.push(`- ${name}: unavailable — ${sec.error}`)
    else lines.push(`- ${name}: skipped — ${sec.reason}`)
  }
  if (graph.unavailable.length > 0) {
    lines.push("")
    lines.push("### Unavailable NEAT sections")
    for (const u of graph.unavailable) lines.push(`- \`${u.section}\` (${u.endpoint}) — ${u.error}`)
  }
  lines.push("")

  lines.push("## Root-cause summary")
  lines.push("")
  lines.push(summarizeSection(graph.sections.rootCause, "rootCause"))
  lines.push("")

  lines.push("## Blast-radius summary")
  lines.push("")
  lines.push(summarizeSection(graph.sections.blastRadius, "blastRadius"))
  lines.push("")

  lines.push("## Risk gates")
  lines.push("")
  lines.push(`Worst status: **${worst}**`)
  lines.push("")
  lines.push(renderRiskGatesMarkdown(riskGates))
  lines.push("")

  lines.push("## Policy gate")
  lines.push("")
  lines.push(`- status: **${policy.status}**`)
  lines.push(`- reason: ${policy.reason}`)
  if (policy.blockingViolations.length > 0) lines.push(`- blocking violations: ${policy.blockingViolations.length}`)
  if (policy.warningViolations.length > 0) lines.push(`- warning violations: ${policy.warningViolations.length}`)
  lines.push("")

  lines.push("## Dispatch")
  lines.push("")
  lines.push(`- dispatched: ${dispatch.dispatched ? "yes" : "no"}`)
  lines.push(`- reason: ${dispatch.reason}`)
  if (dispatch.artifactPath) lines.push(`- request artifact: \`${dispatch.artifactPath}\``)
  lines.push("")

  lines.push("## Artifacts written")
  lines.push("")
  lines.push(`Run directory: \`${runDir}\``)
  for (const a of artifactsWritten) lines.push(`- ${a}`)
  lines.push("")

  lines.push("## Recommended next step")
  lines.push("")
  lines.push(nextStep(worst, policy, dispatch, dryRun, phase, plan))
  lines.push("")

  if (dryRun) {
    lines.push("---")
    lines.push("")
    lines.push("**No code was modified.** This was a Phase 1 dry run. Pistis writes artifacts only.")
  }

  return lines.join("\n")
}

function summarizeSection(section: GraphContext["sections"][keyof GraphContext["sections"]], name: string): string {
  if (section.status === "ok") {
    return `\`${section.endpoint}\` returned a result; see \`graph-context.json\` for the full payload.`
  }
  if (section.status === "unavailable") {
    return `NEAT \`${name}\` endpoint unavailable: ${section.error}`
  }
  return `NEAT \`${name}\` skipped: ${section.reason}`
}

function nextStep(
  worst: string,
  policy: PolicyGateResult,
  dispatch: RemediationDispatchResult,
  dryRun: boolean,
  phase: number,
  plan: RemediationPlan,
): string {
  if (policy.status === "block") {
    return "Resolve the blocking NEAT policy violation(s) before any remediation is dispatched."
  }
  if (worst === "block") {
    return "A risk gate is set to **block**. Remediation cannot be dispatched until the gate is resolved."
  }
  if (worst === "requires_approval") {
    return "One or more risk gates **require approval**. Re-run with the appropriate `--approve-risk <gate-id>` once approval has been recorded."
  }
  if (dryRun && phase === 1) {
    return `Phase 1 dry run completed. The recommended next action is **${plan.nextAction}**. Phase 2 will introduce \`--apply\` to dispatch an OpenCode session.`
  }
  return dispatch.dispatched ? "Review dispatch outputs." : "Re-run without `--dry-run` once Phase 2 is enabled."
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s
}
