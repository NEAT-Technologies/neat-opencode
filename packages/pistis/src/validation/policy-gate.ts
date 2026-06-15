import type { GraphContext } from "../neat/context-builder"
import type { NeatClient } from "../neat/client"

export type PolicyGateStatus = "pass" | "warn" | "block" | "unavailable"

export interface PolicyGateResult {
  status: PolicyGateStatus
  reason: string
  blockingViolations: unknown[]
  warningViolations: unknown[]
  /** Raw NEAT responses for the artifact. */
  raw: {
    fromContext?: unknown
    fromCheck?: unknown
    checkEndpoint?: string
    contextEndpoint?: string
  }
}

/**
 * Pistis does not implement local policy semantics. It interprets NEAT's
 * /policies/violations + /policies/check responses defensively.
 *
 * - Blocking (onViolation === "block") → block.
 * - Warning-level violations → warn.
 * - Endpoint unavailable → unavailable (NOT pass — we are explicit about gaps).
 */
export async function runPolicyGate(client: NeatClient, graph: GraphContext): Promise<PolicyGateResult> {
  const fromContext = graph.sections.policyViolations
  const contextStatus = fromContext.status
  let contextViolations: unknown[] | undefined
  let contextEndpoint: string | undefined
  let contextData: unknown
  if (fromContext.status === "ok") {
    contextEndpoint = fromContext.endpoint
    contextData = fromContext.data
    contextViolations = extractViolations(fromContext.data)
  } else if (fromContext.status === "unavailable") {
    contextEndpoint = fromContext.endpoint
  }

  // Also run /policies/check with no hypothetical to confirm the current
  // allowed/violations state. Some NEAT versions only populate one or the
  // other, so we try both and union them.
  const checkRes = await client.checkPolicies()
  let checkViolations: unknown[] | undefined
  let checkAllowed: boolean | undefined
  if (checkRes.ok) {
    const data = checkRes.data as { allowed?: boolean; violations?: unknown[] }
    if (Array.isArray(data.violations)) checkViolations = data.violations
    if (typeof data.allowed === "boolean") checkAllowed = data.allowed
  }

  // If both endpoints failed and the context section was unavailable, mark unavailable.
  if (!contextViolations && !checkRes.ok && contextStatus !== "ok") {
    return {
      status: "unavailable",
      reason: "NEAT policy endpoints are unavailable; policy validation cannot be performed",
      blockingViolations: [],
      warningViolations: [],
      raw: {
        fromContext: contextData,
        fromCheck: { error: checkRes.error, status: checkRes.status },
        checkEndpoint: checkRes.endpoint,
        contextEndpoint,
      },
    }
  }

  const all: unknown[] = []
  if (contextViolations) all.push(...contextViolations)
  if (checkViolations) all.push(...checkViolations)

  const blocking = all.filter(isBlockingViolation)
  const warnings = all.filter((v) => !isBlockingViolation(v))

  if (blocking.length > 0 || checkAllowed === false) {
    return {
      status: "block",
      reason: `NEAT reports ${blocking.length} blocking policy violation(s)${checkAllowed === false ? " (allowed=false)" : ""}`,
      blockingViolations: blocking,
      warningViolations: warnings,
      raw: {
        fromContext: contextViolations,
        fromCheck: checkRes.ok ? checkRes.data : undefined,
        checkEndpoint: checkRes.endpoint,
        contextEndpoint,
      },
    }
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      reason: `${warnings.length} non-blocking policy violation(s) present`,
      blockingViolations: [],
      warningViolations: warnings,
      raw: {
        fromContext: contextViolations,
        fromCheck: checkRes.ok ? checkRes.data : undefined,
        checkEndpoint: checkRes.endpoint,
        contextEndpoint,
      },
    }
  }

  return {
    status: "pass",
    reason: "no policy violations reported by NEAT",
    blockingViolations: [],
    warningViolations: [],
    raw: {
      fromContext: contextViolations,
      fromCheck: checkRes.ok ? checkRes.data : undefined,
      checkEndpoint: checkRes.endpoint,
      contextEndpoint,
    },
  }
}

function extractViolations(data: unknown): unknown[] | undefined {
  if (!data || typeof data !== "object") return undefined
  const v = (data as { violations?: unknown }).violations
  return Array.isArray(v) ? v : undefined
}

function isBlockingViolation(v: unknown): boolean {
  if (!v || typeof v !== "object") return false
  const obj = v as { onViolation?: unknown; severity?: unknown; action?: unknown }
  if (obj.onViolation === "block") return true
  if (obj.action === "block") return true
  if (typeof obj.severity === "string") {
    const s = obj.severity.toLowerCase()
    if (s === "block" || s === "blocking" || s === "critical") return true
  }
  return false
}
