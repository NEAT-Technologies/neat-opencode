import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { Classification } from "../planner/classifier"

export type GateStatus = "pass" | "warn" | "block" | "requires_approval"

export interface GateResult {
  gateId: string
  status: GateStatus
  reason: string
  evidence: string[]
  /** CLI flag that would unblock this gate, e.g. "--approve-risk db_migration". */
  approvalFlag?: string
}

export interface PreflightInput {
  incident: NormalizedIncident
  graph: GraphContext
  classification: Classification
  /** Approvals already granted on the CLI (e.g. via --approve-risk db_migration). */
  approvals?: string[]
  /** When true, an "unknown + high severity" gate is required-approval. */
  blockUnknownHighSeverity?: boolean
}

const PATH_PATTERNS = {
  db_migration: [/(^|\/)migrations\//i, /(^|\/)prisma\//i, /(^|\/)alembic\//i, /schema\.sql$/i, /(^|\/)db\/schema/i],
  auth: [/(^|\/)auth\//i, /session/i, /jwt/i, /oauth/i],
  payment: [/stripe/i, /billing/i, /checkout/i, /payment/i],
  secrets: [/(^|\/)\.env(\.|$)/i, /secrets?/i, /credentials?/i],
  infra: [/terraform/i, /(^|\/)k8s\//i, /kubernetes/i, /(^|\/)docker/i, /(^|\/)\.github\/workflows\//i, /(^|\/)\.circleci\//i, /(^|\/)\.gitlab-ci/i],
} as const

const DESTRUCTIVE_HINTS = [/\brm\s+-rf\b/i, /\bdrop\s+table\b/i, /\btruncate\s+table\b/i, /\bdelete\s+from\b/i, /force[- ]?push/i]

const BLAST_RADIUS_HIGH_THRESHOLD = 25

/**
 * Phase 1 preflight gates. Inspect incident + graph + classification only — no
 * patch yet. Designed so Phase 2 can extend with diff-based inspection.
 */
export function runPreflightRiskGates(input: PreflightInput): GateResult[] {
  const { incident, graph, classification } = input
  const approvals = new Set(input.approvals ?? [])
  const results: GateResult[] = []

  const allText = textBlob(incident, graph)
  const allPaths = collectPaths(incident, graph)

  results.push(
    pathOrTextGate({
      gateId: "db_migration",
      label: "DB migrations require approval",
      paths: allPaths,
      patterns: [...PATH_PATTERNS.db_migration],
      text: allText,
      textHints: [/migration/i, /\balter\s+table\b/i, /\bcreate\s+table\b/i],
      classificationMatch: classification.class === "db_schema_or_query",
      approved: approvals.has("db_migration"),
    }),
  )

  results.push(
    pathOrTextGate({
      gateId: "auth_change",
      label: "Auth/security changes require approval",
      paths: allPaths,
      patterns: [...PATH_PATTERNS.auth],
      text: allText,
      textHints: [/\bauth\b/i, /\bsession\b/i, /\bjwt\b/i, /\boauth\b/i],
      approved: approvals.has("auth_change"),
    }),
  )

  results.push(
    pathOrTextGate({
      gateId: "payment_change",
      label: "Payment/billing changes require approval",
      paths: allPaths,
      patterns: [...PATH_PATTERNS.payment],
      text: allText,
      textHints: [/stripe/i, /billing/i, /payment/i, /checkout/i],
      approved: approvals.has("payment_change"),
    }),
  )

  results.push(
    pathOrTextGate({
      gateId: "secrets_or_env",
      label: "Secret/env changes require approval",
      paths: allPaths,
      patterns: [...PATH_PATTERNS.secrets],
      text: allText,
      textHints: [/\bsecret/i, /\bcredential/i, /\bAPI_?KEY\b/, /\bTOKEN\b/],
      approved: approvals.has("secrets_or_env"),
    }),
  )

  results.push(
    pathOrTextGate({
      gateId: "infra_change",
      label: "Production infra / CI changes require approval",
      paths: allPaths,
      patterns: [...PATH_PATTERNS.infra],
      text: allText,
      textHints: [/terraform/i, /kubernetes/i, /docker/i, /pipeline/i],
      approved: approvals.has("infra_change"),
    }),
  )

  // Destructive: forbidden by default in Phase 1 — no approval flag advertised.
  const destructiveHits = DESTRUCTIVE_HINTS.filter((re) => re.test(allText)).map((re) => re.toString())
  results.push({
    gateId: "destructive_change",
    status: destructiveHits.length > 0 ? "block" : "pass",
    reason:
      destructiveHits.length > 0
        ? "destructive operation hinted in incident/graph; forbidden by default in Phase 1"
        : "no destructive-operation hints detected",
    evidence: destructiveHits,
  })

  // External-directory writes — always denied in Phase 1.
  results.push({
    gateId: "external_directory_writes",
    status: "block",
    reason: "Phase 1 forbids writes outside the artifact directory",
    evidence: [],
  })

  // Blast radius.
  const blast = countBlastRadius(graph)
  if (blast.unavailable) {
    results.push({
      gateId: "blast_radius",
      status: "warn",
      reason: "NEAT blast-radius unavailable; proceeding without it",
      evidence: [blast.endpointInfo],
    })
  } else if (blast.count >= BLAST_RADIUS_HIGH_THRESHOLD) {
    results.push({
      gateId: "blast_radius",
      status: approvals.has("blast_radius") ? "pass" : "requires_approval",
      reason: `blast radius ${blast.count} ≥ ${BLAST_RADIUS_HIGH_THRESHOLD}`,
      evidence: [blast.endpointInfo],
      approvalFlag: "--approve-risk blast_radius",
    })
  } else {
    results.push({
      gateId: "blast_radius",
      status: "pass",
      reason: `blast radius ${blast.count} below threshold ${BLAST_RADIUS_HIGH_THRESHOLD}`,
      evidence: [blast.endpointInfo],
    })
  }

  // Unknown + high severity.
  const blockUnknownHigh = input.blockUnknownHighSeverity ?? true
  const isHighSev = incident.severity === "high" || incident.severity === "critical"
  if (blockUnknownHigh && classification.class === "unknown" && isHighSev) {
    results.push({
      gateId: "unknown_high_severity",
      status: approvals.has("unknown_high_severity") ? "pass" : "requires_approval",
      reason: `incident classified as 'unknown' with severity '${incident.severity}'; require explicit approval`,
      evidence: classification.reasons,
      approvalFlag: "--approve-risk unknown_high_severity",
    })
  } else {
    results.push({
      gateId: "unknown_high_severity",
      status: "pass",
      reason: `classification=${classification.class}, severity=${incident.severity}`,
      evidence: [],
    })
  }

  return results
}

interface PathOrTextGateInput {
  gateId: string
  label: string
  paths: string[]
  patterns: RegExp[]
  text: string
  textHints: RegExp[]
  classificationMatch?: boolean
  approved: boolean
}

function pathOrTextGate(input: PathOrTextGateInput): GateResult {
  const matchedPaths = input.paths.filter((p) => input.patterns.some((re) => re.test(p)))
  const matchedText = input.textHints.filter((re) => re.test(input.text))
  const triggered = matchedPaths.length > 0 || matchedText.length > 0 || input.classificationMatch === true
  if (!triggered) {
    return {
      gateId: input.gateId,
      status: "pass",
      reason: `${input.label}: no signal detected`,
      evidence: [],
    }
  }
  const evidence: string[] = []
  if (matchedPaths.length > 0) evidence.push(`paths: ${matchedPaths.join(", ")}`)
  if (matchedText.length > 0) evidence.push(`text hints: ${matchedText.map((re) => re.toString()).join(", ")}`)
  if (input.classificationMatch) evidence.push("classification matches risk area")
  return {
    gateId: input.gateId,
    status: input.approved ? "pass" : "requires_approval",
    reason: input.label,
    evidence,
    approvalFlag: `--approve-risk ${input.gateId}`,
  }
}

function textBlob(incident: NormalizedIncident, graph: GraphContext): string {
  const pieces: string[] = [incident.message, incident.issueType]
  for (const e of incident.evidence) {
    if (e.message) pieces.push(e.message)
    if (e.stack) pieces.push(e.stack)
    if (e.snippet) pieces.push(e.snippet)
  }
  pieces.push(...incident.labels)
  // Add NEAT node labels/types if exposed in primaryNode data.
  if (graph.primaryNode.data && typeof graph.primaryNode.data === "object") {
    pieces.push(safeStringify(graph.primaryNode.data))
  }
  if (graph.failingEdge) pieces.push(JSON.stringify(graph.failingEdge))
  return pieces.filter((p) => typeof p === "string" && p.length > 0).join("\n")
}

function collectPaths(incident: NormalizedIncident, graph: GraphContext): string[] {
  const out = new Set<string>()
  for (const f of incident.candidateFiles) out.add(f)
  for (const e of incident.evidence) {
    if (typeof e.file === "string" && e.file.length > 0) out.add(e.file)
  }
  // Node IDs often encode file paths (e.g. "file:src/auth/login.ts:42").
  if (incident.primaryNodeId.includes("/")) out.add(incident.primaryNodeId)
  // Pull plausible string fields out of NEAT graph data.
  if (graph.primaryNode.data && typeof graph.primaryNode.data === "object") {
    walkStrings(graph.primaryNode.data, (s) => {
      if (looksLikePath(s)) out.add(s)
    })
  }
  return [...out]
}

function walkStrings(value: unknown, fn: (s: string) => void, depth = 0): void {
  if (depth > 4) return
  if (typeof value === "string") {
    fn(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, fn, depth + 1)
    return
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) walkStrings(v, fn, depth + 1)
  }
}

function looksLikePath(s: string): boolean {
  if (s.length === 0 || s.length > 512) return false
  if (s.includes("\n")) return false
  return s.includes("/") || s.endsWith(".ts") || s.endsWith(".js") || s.endsWith(".tsx") || s.endsWith(".py") || s.endsWith(".sql")
}

function countBlastRadius(graph: GraphContext): { unavailable: boolean; count: number; endpointInfo: string } {
  const sec = graph.sections.blastRadius
  if (sec.status !== "ok") return { unavailable: true, count: 0, endpointInfo: `endpoint=${sec.status === "unavailable" ? sec.endpoint : "skipped"}` }
  const data = sec.data
  if (!data || typeof data !== "object") return { unavailable: false, count: 0, endpointInfo: `endpoint=${sec.endpoint}` }
  // NEAT shapes vary; try common keys.
  for (const k of ["affectedNodes", "nodes", "items"] as const) {
    const v = (data as Record<string, unknown>)[k]
    if (Array.isArray(v)) return { unavailable: false, count: v.length, endpointInfo: `endpoint=${sec.endpoint}, key=${k}` }
  }
  if (typeof (data as { count?: unknown }).count === "number") {
    return { unavailable: false, count: (data as { count: number }).count, endpointInfo: `endpoint=${sec.endpoint}, key=count` }
  }
  return { unavailable: false, count: 0, endpointInfo: `endpoint=${sec.endpoint}, key=<none-matched>` }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Summarize gate results into the worst status seen.
 */
export function worstStatus(gates: GateResult[]): GateStatus {
  let worst: GateStatus = "pass"
  for (const g of gates) {
    if (g.status === "block") return "block"
    if (g.status === "requires_approval") worst = "requires_approval"
    else if (g.status === "warn" && worst === "pass") worst = "warn"
  }
  return worst
}

/**
 * Markdown summary for plan.md / final-report.md.
 */
export function renderRiskGatesMarkdown(gates: GateResult[]): string {
  const lines: string[] = []
  for (const g of gates) {
    const icon = g.status === "pass" ? "✓" : g.status === "warn" ? "!" : g.status === "block" ? "✗" : "?"
    lines.push(`- ${icon} **${g.gateId}** — ${g.status}: ${g.reason}`)
    if (g.evidence.length > 0) {
      for (const e of g.evidence) lines.push(`    - ${e}`)
    }
    if (g.approvalFlag) lines.push(`    - to approve: \`${g.approvalFlag}\``)
  }
  return lines.join("\n")
}
