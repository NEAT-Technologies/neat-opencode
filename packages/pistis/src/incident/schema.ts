import { z } from "zod"

/**
 * Pistis incident schema. Accepts NEAT-like incident JSON with loose fields and
 * normalizes it into a stable internal shape used by the rest of Pistis.
 *
 * The raw schema is intentionally permissive — NEAT can evolve its incident
 * payload without breaking Pistis. Anything we don't recognize lands in
 * `metadata` so risk gates and reports can still inspect it.
 */

export const Severity = z.enum(["info", "low", "medium", "high", "critical"])
export type Severity = z.infer<typeof Severity>

export const Evidence = z
  .object({
    kind: z.string().optional(),
    message: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    stack: z.string().optional(),
    snippet: z.string().optional(),
    timestamp: z.string().optional(),
    source: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type Evidence = z.infer<typeof Evidence>

/**
 * Permissive raw incident — fields are intentionally optional/aliasable. NEAT
 * may emit slightly different shapes; we coerce to the normalized form below.
 */
export const RawIncident = z
  .object({
    // ids
    id: z.string().optional(),
    incidentId: z.string().optional(),
    incident_id: z.string().optional(),

    // classification hints
    type: z.string().optional(),
    issueType: z.string().optional(),
    issue_type: z.string().optional(),
    kind: z.string().optional(),
    category: z.string().optional(),

    // severity
    severity: z.union([Severity, z.string()]).optional(),
    priority: z.string().optional(),

    // primary node
    nodeId: z.string().optional(),
    node_id: z.string().optional(),
    primaryNodeId: z.string().optional(),
    primary_node_id: z.string().optional(),
    node: z
      .object({
        id: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),

    // failing edge
    failingEdgeId: z.string().optional(),
    failing_edge_id: z.string().optional(),
    edgeId: z.string().optional(),
    failingEdge: z
      .object({
        id: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        type: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),

    // error
    errorId: z.string().optional(),
    error_id: z.string().optional(),

    // message
    message: z.string().optional(),
    summary: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),

    // evidence
    evidence: z.union([Evidence, z.array(Evidence)]).optional(),

    // candidate files
    candidateFiles: z.array(z.string()).optional(),
    candidate_files: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),

    // project
    project: z.string().optional(),

    // metadata
    metadata: z.record(z.string(), z.unknown()).optional(),

    // labels/tags often used by NEAT
    labels: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .catchall(z.unknown())

export type RawIncident = z.infer<typeof RawIncident>

/**
 * Normalized incident — what the rest of Pistis consumes.
 */
export interface NormalizedIncident {
  incidentId: string
  issueType: string
  severity: Severity
  primaryNodeId: string
  failingEdgeId?: string
  failingEdge?: {
    id?: string
    from?: string
    to?: string
    type?: string
  }
  errorId?: string
  message: string
  evidence: Evidence[]
  candidateFiles: string[]
  project?: string
  labels: string[]
  metadata: Record<string, unknown>
}

function pickString(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v
  return undefined
}

function coerceSeverity(input: unknown): Severity {
  if (typeof input !== "string") return "medium"
  const v = input.toLowerCase()
  if (v === "info" || v === "low" || v === "medium" || v === "high" || v === "critical") return v
  if (v === "warn" || v === "warning" || v === "notice") return "low"
  if (v === "error") return "high"
  if (v === "fatal" || v === "sev1" || v === "p0" || v === "p1") return "critical"
  if (v === "sev2" || v === "p2") return "high"
  if (v === "sev3" || v === "p3") return "medium"
  if (v === "sev4" || v === "p4") return "low"
  return "medium"
}

function coerceEvidence(input: unknown): Evidence[] {
  if (input == null) return []
  if (Array.isArray(input)) {
    return input.map((e) => Evidence.parse(e))
  }
  return [Evidence.parse(input)]
}

export class IncidentValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message)
    this.name = "IncidentValidationError"
  }
}

/**
 * Parse + normalize an arbitrary JSON value into a NormalizedIncident.
 * Throws IncidentValidationError if required fields can't be resolved.
 */
export function normalizeIncident(input: unknown): NormalizedIncident {
  let raw: RawIncident
  try {
    raw = RawIncident.parse(input)
  } catch (err) {
    const issues = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : [String(err)]
    throw new IncidentValidationError("incident JSON failed schema validation", issues)
  }

  const incidentId = pickString(raw.incidentId, raw.incident_id, raw.id)
  if (!incidentId) {
    throw new IncidentValidationError("incident is missing required field: incidentId (or id)")
  }

  const primaryNodeId = pickString(raw.primaryNodeId, raw.primary_node_id, raw.nodeId, raw.node_id, raw.node?.id)
  if (!primaryNodeId) {
    throw new IncidentValidationError("incident is missing required field: primaryNodeId (or nodeId)")
  }

  const message = pickString(raw.message, raw.summary, raw.title, raw.description) ?? ""

  const issueType = pickString(raw.issueType, raw.issue_type, raw.type, raw.kind, raw.category) ?? "unknown"

  const failingEdgeId = pickString(raw.failingEdgeId, raw.failing_edge_id, raw.edgeId, raw.failingEdge?.id)

  const candidateFiles = (raw.candidateFiles ?? raw.candidate_files ?? raw.files ?? []).filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  )

  const labels = [...(raw.labels ?? []), ...(raw.tags ?? [])].filter((s): s is string => typeof s === "string")

  return {
    incidentId,
    issueType,
    severity: coerceSeverity(raw.severity ?? raw.priority),
    primaryNodeId,
    failingEdgeId,
    failingEdge: raw.failingEdge
      ? {
          id: raw.failingEdge.id,
          from: raw.failingEdge.from,
          to: raw.failingEdge.to,
          type: raw.failingEdge.type,
        }
      : undefined,
    errorId: pickString(raw.errorId, raw.error_id),
    message,
    evidence: coerceEvidence(raw.evidence),
    candidateFiles,
    project: raw.project,
    labels,
    metadata: raw.metadata ?? {},
  }
}

/**
 * Load + normalize an incident JSON file from disk.
 */
export async function loadIncidentFile(filePath: string): Promise<NormalizedIncident> {
  const fs = await import("node:fs/promises")
  let text: string
  try {
    text = await fs.readFile(filePath, "utf8")
  } catch (err) {
    throw new IncidentValidationError(`failed to read incident file: ${filePath}`, [String(err)])
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new IncidentValidationError(`incident file is not valid JSON: ${filePath}`, [String(err)])
  }
  return normalizeIncident(parsed)
}
