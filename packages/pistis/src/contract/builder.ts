import type { AgentContract } from "./types"
import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { Classification } from "../planner/classifier"
import type { GateResult } from "../validation/risk-gate"

/**
 * Path patterns Pistis forbids workers from touching by default. Derived from
 * the risk-gate path patterns in the contract spec.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)migrations(?:\/|$)/i,
  /(?:^|\/)prisma\//i,
  /(?:^|\/)alembic\//i,
  /(?:^|\/)schema\.sql$/i,
  /(?:^|\/)db\/schema/i,
  /(?:^|\/)auth(?:\/|$)/i,
  /(?:^|\/)session[s]?\b/i,
  /(?:^|\/)jwt\b/i,
  /(?:^|\/)oauth\b/i,
  /(?:^|\/)stripe\b/i,
  /(?:^|\/)billing\b/i,
  /(?:^|\/)checkout\b/i,
  /(?:^|\/)payment[s]?\b/i,
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)secrets(?:\/|$)/i,
  /(?:^|\/)terraform\//i,
  /(?:^|\/)k8s\//i,
  /(?:^|\/)kubernetes\//i,
  /(?:^|\/)docker(?:file|-compose)?/i,
  /(?:^|\/)\.github\/workflows\//i,
]

export interface BuildAgentContractOptions {
  incident: NormalizedIncident
  graph: GraphContext
  plan: RemediationPlan
  classification: Classification
  riskGates: GateResult[]
  testCommands: string[]
  /** For the contract id sequence. Phase 2 always uses 0; multi-agent phases will increment. */
  sequence?: number
  /** Defaults to 2. Worker retries are capped by both this and the dispatcher loop. */
  maxRetries?: number
  /** Phase 2 only ships role="patch". Phase 3+ introduces role-specific builders. */
  agentRole?: string
}

export function buildAgentContract(opts: BuildAgentContractOptions): AgentContract {
  const role = opts.agentRole ?? "patch"
  const seq = opts.sequence ?? 0
  const contractId = `${opts.incident.incidentId}::${role}::${String(seq).padStart(3, "0")}`

  const allowedFiles = uniqueSorted(opts.incident.candidateFiles)
  const forbiddenFiles = uniqueSorted([
    ...allowedFiles.filter(isForbiddenPath),
    // Additional explicit deny-listed files based on blocking risk gates.
    ...riskGateForbidden(opts.riskGates),
  ])

  return {
    contractId,
    agentRole: role,
    objective: buildObjective(opts),
    graphContext: opts.graph,
    allowedFiles,
    forbiddenFiles,
    constraints: buildConstraints(opts),
    successCriteria: buildSuccessCriteria(opts),
    requiredOutputs: ["patch.diff", "agent-result.json"],
    validationCommands: [...opts.testCommands],
    maxRetries: opts.maxRetries ?? 2,
  }
}

function buildObjective(opts: BuildAgentContractOptions): string {
  const sev = opts.incident.severity
  const cls = opts.classification.class
  const node = opts.incident.primaryNodeId ?? "(unknown)"
  const msg = (opts.incident.message ?? "").trim()
  const head = `Investigate and remediate incident ${opts.incident.incidentId} on node ${node} (class=${cls}, severity=${sev}).`
  const tail = msg ? `\n\nReported message:\n${msg}` : ""
  return head + tail
}

function buildConstraints(opts: BuildAgentContractOptions): string[] {
  const c: string[] = [
    "Modify only files inside `allowedFiles`.",
    "Never modify files inside `forbiddenFiles`.",
    "Do not commit, push, or merge.",
    "Do not delete files unless explicitly required by `objective`.",
    "Do not run arbitrary shell commands. Only commands in `validationCommands` may be executed.",
    "Do not call out to external network services other than via NEAT REST.",
  ]
  if (opts.classification.class === "db_schema_or_query") {
    c.push("Database schema changes require human approval — propose a migration file but do not run it.")
  }
  if (opts.incident.severity === "critical" || opts.incident.severity === "high") {
    c.push("Severity is high/critical: prefer the smallest reversible change that satisfies success criteria.")
  }
  return c
}

function buildSuccessCriteria(opts: BuildAgentContractOptions): string[] {
  const sc: string[] = [
    "Produce a unified diff in `patch.diff` with at least one file changed.",
    "All files in the diff are within `allowedFiles`.",
    "No files in the diff are within `forbiddenFiles`.",
    "AgentResult.summary explains the root cause and the change.",
  ]
  if (opts.testCommands.length > 0) {
    sc.push(`All validation commands exit zero: ${opts.testCommands.map((c) => `\`${c}\``).join(", ")}.`)
  }
  if (opts.classification.class === "policy_violation") {
    sc.push("Re-running NEAT /policies/check returns allowed=true.")
  }
  return sc
}

function isForbiddenPath(path: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(path))
}

function riskGateForbidden(gates: GateResult[]): string[] {
  const out: string[] = []
  for (const g of gates) {
    if (g.status === "block" || g.status === "requires_approval") {
      if (Array.isArray(g.evidence)) {
        for (const e of g.evidence) {
          if (typeof e === "string") out.push(e)
        }
      }
    }
  }
  return out.filter((p) => p.includes("/") || p.startsWith("."))
}

function uniqueSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort()
}
