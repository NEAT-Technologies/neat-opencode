import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { Classification, IssueClass } from "./classifier"

export interface RemediationStrategy {
  name: string
  description: string
  agentTasks: AgentTask[]
}

export interface AgentTask {
  id: string
  agent: "implementer" | "reviewer" | "tester"
  description: string
  inputs: string[]
}

export interface RemediationPlan {
  incidentId: string
  issueClass: IssueClass
  classificationReasons: string[]
  affected: {
    primaryNodeId: string
    failingEdge?: GraphContext["failingEdge"]
    candidateFiles: string[]
    blastRadiusConsidered: boolean
  }
  strategy: RemediationStrategy
  validationCommands: string[]
  nextAction:
    | "dispatch_to_opencode"
    | "await_approval"
    | "request_more_context"
    | "no_action"
  rationale: string
}

export interface BuildPlanOptions {
  testCommands: string[]
}

export function buildPlan(
  incident: NormalizedIncident,
  graph: GraphContext,
  classification: Classification,
  opts: BuildPlanOptions,
): RemediationPlan {
  const strategy = strategyFor(classification.class, incident, graph)
  return {
    incidentId: incident.incidentId,
    issueClass: classification.class,
    classificationReasons: classification.reasons,
    affected: {
      primaryNodeId: incident.primaryNodeId,
      failingEdge: graph.failingEdge,
      candidateFiles: incident.candidateFiles,
      blastRadiusConsidered: graph.sections.blastRadius.status === "ok",
    },
    strategy,
    validationCommands: opts.testCommands,
    nextAction: classification.class === "unknown" ? "request_more_context" : "dispatch_to_opencode",
    rationale: rationaleFor(classification, graph),
  }
}

function strategyFor(cls: IssueClass, incident: NormalizedIncident, graph: GraphContext): RemediationStrategy {
  const inputs = collectInputs(incident, graph)
  switch (cls) {
    case "runtime_exception":
      return {
        name: "isolate-and-patch",
        description:
          "Locate the throwing call site from the stack trace, identify the invariant violated, " +
          "and patch the smallest scope that restores it. Add a regression test.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Reproduce the exception locally, patch the failing site, add a regression test.",
            inputs,
          },
        ],
      }
    case "http_5xx":
      return {
        name: "endpoint-stabilization",
        description:
          "Trace the 5xx back to its underlying cause (handler exception, dependency failure, " +
          "or contract mismatch) and apply the minimal fix.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Diagnose the 5xx using stack/log evidence and apply a minimal fix.",
            inputs,
          },
        ],
      }
    case "db_schema_or_query":
      return {
        name: "schema-or-query-fix",
        description:
          "Fix is in the query, ORM model, or migration. Requires explicit approval before any " +
          "migration is applied — Phase 1 only plans; Phase 2 dispatches with approval gates.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description:
              "Adjust query/ORM model or author a forward migration. DO NOT apply migrations without approval.",
            inputs,
          },
        ],
      }
    case "policy_violation":
      return {
        name: "policy-compliance",
        description: "Restore compliance with the violated NEAT policy. Pistis does not redefine the policy locally.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Reshape the offending code so it no longer triggers the policy.",
            inputs,
          },
        ],
      }
    case "stale_edge":
      return {
        name: "stale-edge-investigation",
        description:
          "An edge NEAT expected to be live is stale. Determine whether the consumer was removed, " +
          "the producer stopped emitting, or instrumentation lapsed. Pistis does not auto-delete edges.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description:
              "Decide between restoring the producer, removing the dead consumer, or reinstating instrumentation. " +
              "Edge deletion is a NEAT-side concern, not Pistis's.",
            inputs,
          },
        ],
      }
    case "divergence":
      return {
        name: "reconcile-divergence",
        description:
          "Declared intent and observed reality have diverged. Bring one side into agreement with the other " +
          "based on what the team actually wants to ship.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Reconcile the divergence — update code, infra, or expectations to match.",
            inputs,
          },
        ],
      }
    case "dependency_failure":
      return {
        name: "dependency-failure-mitigation",
        description:
          "Upstream/dependency failure surfaced into this service. Add the missing timeout, retry, " +
          "circuit breaker, or fallback at the call site — not by silencing the error.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Add the minimal resilience pattern that addresses the dependency failure.",
            inputs,
          },
        ],
      }
    case "missing_instrumentation":
      return {
        name: "instrument-the-gap",
        description:
          "NEAT cannot observe this path because nothing emits spans/logs. Add the missing instrumentation " +
          "so NEAT can verify the next iteration.",
        agentTasks: [
          {
            id: "implement",
            agent: "implementer",
            description: "Add OpenTelemetry spans / structured logs that close NEAT's observability gap.",
            inputs,
          },
        ],
      }
    case "unknown":
    default:
      return {
        name: "investigate-then-plan",
        description:
          "Pistis could not classify the incident from the available signals. " +
          "Surface this back to the operator before dispatching any agent.",
        agentTasks: [
          {
            id: "investigate",
            agent: "reviewer",
            description:
              "Inspect the incident + graph context, propose a classification, and request human confirmation.",
            inputs,
          },
        ],
      }
  }
}

function collectInputs(incident: NormalizedIncident, graph: GraphContext): string[] {
  const inputs = ["incident.json", "graph-context.json"]
  if (incident.candidateFiles.length > 0) inputs.push("candidateFiles[]")
  if (graph.sections.rootCause.status === "ok") inputs.push("rootCauseFromNeat")
  if (graph.sections.blastRadius.status === "ok") inputs.push("blastRadiusFromNeat")
  return inputs
}

function rationaleFor(cls: Classification, graph: GraphContext): string {
  const parts = [`classified as ${cls.class} (${cls.confidence} confidence)`, ...cls.reasons]
  if (graph.unavailable.length > 0) {
    parts.push(
      `NEAT sections unavailable: ${graph.unavailable.map((u) => `${u.section}(${u.status ?? "net"})`).join(", ")}`,
    )
  }
  return parts.join("; ")
}

/**
 * Render the plan as Markdown for plan.md.
 */
export function renderPlanMarkdown(
  incident: NormalizedIncident,
  graph: GraphContext,
  plan: RemediationPlan,
  riskGateSummary: string,
): string {
  const lines: string[] = []
  lines.push(`# Pistis Remediation Plan — ${plan.incidentId}`)
  lines.push("")
  lines.push("> Phase 1 (dry-run): no code changes will be made.")
  lines.push("")

  lines.push("## Incident")
  lines.push("")
  lines.push(`- **id:** ${incident.incidentId}`)
  lines.push(`- **issueType (raw):** ${incident.issueType}`)
  lines.push(`- **severity:** ${incident.severity}`)
  lines.push(`- **primaryNodeId:** ${incident.primaryNodeId}`)
  if (incident.failingEdgeId) lines.push(`- **failingEdgeId:** ${incident.failingEdgeId}`)
  if (incident.errorId) lines.push(`- **errorId:** ${incident.errorId}`)
  if (incident.project) lines.push(`- **project:** ${incident.project}`)
  lines.push(`- **message:** ${truncate(incident.message, 400)}`)
  lines.push("")

  lines.push("## Graph context summary")
  lines.push("")
  lines.push(`- NEAT base URL: \`${graph.neat.baseUrl}\``)
  if (graph.neat.project) lines.push(`- NEAT project: \`${graph.neat.project}\``)
  lines.push(`- Primary node fetched: ${graph.primaryNode.fetched ? "yes" : "no"}`)
  for (const [name, sec] of Object.entries(graph.sections)) {
    lines.push(`- ${name}: ${sec.status}${sec.status === "unavailable" ? ` (${sec.error})` : ""}`)
  }
  lines.push("")

  lines.push("## Classification")
  lines.push("")
  lines.push(`- **class:** ${plan.issueClass}`)
  lines.push(`- **reasons:**`)
  for (const r of plan.classificationReasons) lines.push(`  - ${r}`)
  lines.push("")

  lines.push("## Affected")
  lines.push("")
  lines.push(`- primary node: \`${plan.affected.primaryNodeId}\``)
  if (plan.affected.failingEdge) {
    const e = plan.affected.failingEdge
    lines.push(`- failing edge: ${e.id ?? "?"} (${e.from ?? "?"} → ${e.to ?? "?"}, type=${e.type ?? "?"})`)
  }
  lines.push(`- candidate files: ${plan.affected.candidateFiles.length}`)
  for (const f of plan.affected.candidateFiles) lines.push(`  - \`${f}\``)
  lines.push(`- blast radius considered: ${plan.affected.blastRadiusConsidered ? "yes" : "no"}`)
  lines.push("")

  lines.push("## Recommended remediation strategy")
  lines.push("")
  lines.push(`**${plan.strategy.name}** — ${plan.strategy.description}`)
  lines.push("")
  lines.push("### Proposed agent tasks")
  lines.push("")
  for (const t of plan.strategy.agentTasks) {
    lines.push(`- \`${t.id}\` (${t.agent}) — ${t.description}`)
    lines.push(`  - inputs: ${t.inputs.join(", ")}`)
  }
  lines.push("")

  lines.push("## Validation commands")
  lines.push("")
  if (plan.validationCommands.length === 0) {
    lines.push("- (none configured; pass `--test-command` to set them)")
  } else {
    for (const cmd of plan.validationCommands) lines.push(`- \`${cmd}\``)
  }
  lines.push("")

  lines.push("## Risk gates")
  lines.push("")
  lines.push(riskGateSummary)
  lines.push("")

  lines.push("## Next action")
  lines.push("")
  lines.push(`**${plan.nextAction}** — ${plan.rationale}`)
  lines.push("")

  return lines.join("\n")
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s
}
