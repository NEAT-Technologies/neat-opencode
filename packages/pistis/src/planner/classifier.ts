import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"

export const ISSUE_CLASSES = [
  "runtime_exception",
  "http_5xx",
  "db_schema_or_query",
  "policy_violation",
  "stale_edge",
  "divergence",
  "dependency_failure",
  "missing_instrumentation",
  "unknown",
] as const

export type IssueClass = (typeof ISSUE_CLASSES)[number]

export interface Classification {
  class: IssueClass
  confidence: "high" | "medium" | "low"
  reasons: string[]
}

/**
 * Deterministic rule-based incident classifier. NEAT may eventually classify
 * incidents itself; until then, Pistis derives a class from incident text +
 * graph context. Order of rules matters: explicit signals (policy violations,
 * stale-edge, divergence) win before generic text matching.
 */
export function classifyIncident(incident: NormalizedIncident, graph: GraphContext): Classification {
  const reasons: string[] = []
  const issueType = (incident.issueType ?? "").toLowerCase()
  const message = (incident.message ?? "").toLowerCase()
  const labels = incident.labels.map((s) => s.toLowerCase())
  const allFiles = incident.candidateFiles.map((s) => s.toLowerCase())
  const edgeType = (incident.failingEdge?.type ?? "").toLowerCase()

  const hasLabel = (substr: string) => labels.some((l) => l.includes(substr))
  const hasFile = (substr: string) => allFiles.some((f) => f.includes(substr))
  const messageMatches = (re: RegExp) => re.test(message)

  // 1. Explicit incident-type hints — NEAT/Pistis incident JSON may say it
  //    outright. These are deterministic high-confidence wins.
  const typeMap: Record<string, IssueClass> = {
    runtime_exception: "runtime_exception",
    exception: "runtime_exception",
    http_5xx: "http_5xx",
    "5xx": "http_5xx",
    db_schema_or_query: "db_schema_or_query",
    db: "db_schema_or_query",
    schema: "db_schema_or_query",
    query: "db_schema_or_query",
    policy_violation: "policy_violation",
    stale_edge: "stale_edge",
    stale: "stale_edge",
    divergence: "divergence",
    dependency_failure: "dependency_failure",
    missing_instrumentation: "missing_instrumentation",
  }
  if (typeMap[issueType]) {
    reasons.push(`incident.issueType="${issueType}" maps directly to ${typeMap[issueType]}`)
    return { class: typeMap[issueType], confidence: "high", reasons }
  }

  // 2. Policy violations from NEAT context — these are authoritative.
  const policy = graph.sections.policyViolations
  if (policy.status === "ok" && hasViolations(policy.data)) {
    reasons.push("NEAT /policies/violations returned non-empty violations")
    return { class: "policy_violation", confidence: "high", reasons }
  }

  // 3. Stale edge: explicit edge metadata or labels.
  if (edgeType === "stale" || hasLabel("stale") || messageMatches(/\bstale\b/)) {
    reasons.push(
      [
        edgeType === "stale" ? `failingEdge.type="stale"` : null,
        hasLabel("stale") ? "label contains stale" : null,
        messageMatches(/\bstale\b/) ? "message mentions stale" : null,
      ]
        .filter(Boolean)
        .join("; "),
    )
    return { class: "stale_edge", confidence: "high", reasons }
  }

  // 4. Divergence: NEAT divergence section returned actionable data.
  const div = graph.sections.divergences
  if (div.status === "ok" && hasDivergences(div.data)) {
    reasons.push("NEAT /graph/divergences returned non-empty divergences")
    return { class: "divergence", confidence: "high", reasons }
  }
  if (hasLabel("divergence") || messageMatches(/\bdivergen/)) {
    reasons.push("incident labels/message indicate divergence")
    return { class: "divergence", confidence: "medium", reasons }
  }

  // 5. DB schema/query.
  if (
    hasFile("migrations/") ||
    hasFile("prisma/") ||
    hasFile("alembic/") ||
    hasFile("schema.sql") ||
    hasFile("db/schema") ||
    messageMatches(/\b(?:syntax error|relation .* does not exist|column .* does not exist|undefined table|undefined column|migration|alter table|drop table|create table)\b/i)
  ) {
    reasons.push("path or message suggests DB schema/query")
    return { class: "db_schema_or_query", confidence: "medium", reasons }
  }

  // 6. HTTP 5xx — incident from an HTTP endpoint, or 5xx in evidence/message.
  if (
    messageMatches(/\b5\d\d\b/) ||
    messageMatches(/internal server error|bad gateway|service unavailable|gateway timeout/) ||
    hasLabel("http") ||
    incident.primaryNodeId.startsWith("endpoint:") ||
    incident.primaryNodeId.startsWith("route:")
  ) {
    reasons.push("evidence/message/node-id suggests HTTP 5xx")
    return { class: "http_5xx", confidence: "medium", reasons }
  }

  // 7. Runtime exception — stack trace shape, common error class names.
  if (
    incident.evidence.some((e) => typeof e.stack === "string" && e.stack.length > 0) ||
    messageMatches(/\b(typeerror|referenceerror|valueerror|nullpointerexception|exception|traceback)\b/)
  ) {
    reasons.push("evidence stack trace or known exception class")
    return { class: "runtime_exception", confidence: "medium", reasons }
  }

  // 8. Dependency failure: outbound dependency edges flagged unavailable, or text hints.
  if (messageMatches(/\b(econnrefused|enotfound|etimedout|upstream|dependency|timeout)\b/)) {
    reasons.push("message indicates upstream/dependency failure")
    return { class: "dependency_failure", confidence: "medium", reasons }
  }

  // 9. Missing instrumentation: NEAT often flags this via specific label/type.
  if (hasLabel("uninstrumented") || hasLabel("missing_instrumentation") || messageMatches(/uninstrumented|no spans observed|never observed/)) {
    reasons.push("labels/message indicate missing instrumentation")
    return { class: "missing_instrumentation", confidence: "medium", reasons }
  }

  reasons.push("no rule matched; defaulting to unknown")
  return { class: "unknown", confidence: "low", reasons }
}

function hasViolations(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  const v = (data as { violations?: unknown }).violations
  return Array.isArray(v) && v.length > 0
}

function hasDivergences(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  // NEAT divergence shape: DivergenceResult — be permissive.
  const candidates = ["divergences", "results", "items"] as const
  for (const k of candidates) {
    const v = (data as Record<string, unknown>)[k]
    if (Array.isArray(v) && v.length > 0) return true
  }
  return false
}
