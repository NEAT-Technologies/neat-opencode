import type { NormalizedIncident } from "../incident/schema"
import { NeatClient, NeatHttpError, NeatNetworkError, type NeatResult } from "./client"

/**
 * Deterministic graph-context.json. NEAT owns graph truth; this module only
 * organizes whatever NEAT returns and records exactly which optional sections
 * were unavailable. We never traverse the graph locally.
 */
export interface GraphContext {
  neat: {
    baseUrl: string
    project?: string
    healthOk: boolean
    healthError?: string
  }
  primaryNode: {
    id: string
    fetched: boolean
    data?: unknown
    error?: string
  }
  failingEdge?: {
    id?: string
    from?: string
    to?: string
    type?: string
  }
  incident: {
    id: string
    issueType: string
    severity: string
    message: string
    evidence: unknown[]
    candidateFiles: string[]
    labels: string[]
  }
  sections: {
    edges: SectionResult
    rootCause: SectionResult
    blastRadius: SectionResult
    dependencies: SectionResult
    divergences: SectionResult
    incidentsForNode: SectionResult
    policyViolations: SectionResult
  }
  unavailable: Array<{ section: string; endpoint: string; status?: number; error: string }>
}

export type SectionResult =
  | { status: "ok"; endpoint: string; data: unknown }
  | { status: "unavailable"; endpoint: string; httpStatus?: number; error: string }
  | { status: "skipped"; reason: string }

export interface BuildGraphContextOptions {
  blastRadiusDepth?: number
  dependenciesDepth?: number
}

/**
 * Fetch NEAT context for the incident. Throws only on `/health` or primary node
 * lookup failure (these are required); every other section degrades to
 * `unavailable` so the run can still emit a useful report.
 */
export async function buildGraphContext(
  client: NeatClient,
  incident: NormalizedIncident,
  opts: BuildGraphContextOptions = {},
): Promise<GraphContext> {
  const unavailable: GraphContext["unavailable"] = []

  // Required: health
  let healthOk = true
  let healthError: string | undefined
  try {
    await client.health()
  } catch (err) {
    healthOk = false
    healthError = err instanceof Error ? err.message : String(err)
    throw new Error(`NEAT /health failed: ${healthError}`)
  }

  // Required: primary node
  const primaryNode: GraphContext["primaryNode"] = {
    id: incident.primaryNodeId,
    fetched: false,
  }
  try {
    primaryNode.data = await client.getNode(incident.primaryNodeId)
    primaryNode.fetched = true
  } catch (err) {
    if (err instanceof NeatHttpError) {
      primaryNode.error = `HTTP ${err.status}: ${asString(err.body)}`
    } else if (err instanceof NeatNetworkError) {
      primaryNode.error = err.message
    } else {
      primaryNode.error = err instanceof Error ? err.message : String(err)
    }
    throw new Error(`NEAT primary node lookup failed for "${incident.primaryNodeId}": ${primaryNode.error}`)
  }

  const [edges, rootCause, blastRadius, dependencies, divergences, incidentsForNode, policyViolations] =
    await Promise.all([
      client.getEdges(incident.primaryNodeId),
      client.getRootCause(incident.primaryNodeId, incident.errorId),
      client.getBlastRadius(incident.primaryNodeId, opts.blastRadiusDepth),
      client.getDependencies(incident.primaryNodeId, opts.dependenciesDepth),
      client.getDivergences(incident.primaryNodeId),
      client.getIncidentsForNode(incident.primaryNodeId),
      client.getPolicyViolations(),
    ])

  const sections: GraphContext["sections"] = {
    edges: toSection(edges, unavailable, "edges"),
    rootCause: toSection(rootCause, unavailable, "rootCause"),
    blastRadius: toSection(blastRadius, unavailable, "blastRadius"),
    dependencies: toSection(dependencies, unavailable, "dependencies"),
    divergences: toSection(divergences, unavailable, "divergences"),
    incidentsForNode: toSection(incidentsForNode, unavailable, "incidentsForNode"),
    policyViolations: toSection(policyViolations, unavailable, "policyViolations"),
  }

  return {
    neat: {
      baseUrl: client.baseUrl,
      project: client.project,
      healthOk,
      healthError,
    },
    primaryNode,
    failingEdge: incident.failingEdge,
    incident: {
      id: incident.incidentId,
      issueType: incident.issueType,
      severity: incident.severity,
      message: incident.message,
      evidence: incident.evidence,
      candidateFiles: incident.candidateFiles,
      labels: incident.labels,
    },
    sections,
    unavailable,
  }
}

function toSection(
  result: NeatResult<unknown>,
  unavailable: GraphContext["unavailable"],
  name: string,
): SectionResult {
  if (result.ok) {
    return { status: "ok", endpoint: result.endpoint, data: result.data }
  }
  unavailable.push({ section: name, endpoint: result.endpoint, status: result.status, error: result.error })
  return { status: "unavailable", endpoint: result.endpoint, httpStatus: result.status, error: result.error }
}

function asString(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
