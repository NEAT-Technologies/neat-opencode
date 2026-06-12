import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { GateResult } from "../validation/risk-gate"
import type { PolicyGateResult } from "../validation/policy-gate"

/**
 * Phase 1 dispatcher contract. Phase 2 introduces OpenCodeSessionDispatcher
 * that actually starts an OpenCode session; the interface stays identical so
 * planner/context code doesn't change.
 */
export interface RemediationDispatcher {
  readonly name: string
  dispatch(input: RemediationDispatchInput): Promise<RemediationDispatchResult>
}

export interface RemediationDispatchInput {
  incident: NormalizedIncident
  graphContext: GraphContext
  plan: RemediationPlan
  candidateFiles: string[]
  constraints: DispatchConstraints
  safetyRules: SafetyRules
  /** Outputs Pistis wants the implementation agent to produce. */
  requestedOutputs: RequestedOutputs
  dryRun: boolean
}

export interface DispatchConstraints {
  /** Maximum agent wall-clock time, ms. */
  timeoutMs: number
  /** Maximum files the agent may modify. */
  maxFiles: number
  /** Test commands that must pass before the agent declares done. */
  testCommands: string[]
}

export interface SafetyRules {
  forbidDestructiveOps: boolean
  forbidExternalDirectoryWrites: boolean
  forbidShellWithoutAllowlist: boolean
  blockingRiskGates: string[]
  blockingPolicyViolations: number
}

export interface RequestedOutputs {
  patchDiff: boolean
  agentEventsJsonl: boolean
  sessionTranscript: boolean
}

export interface RemediationDispatchResult {
  dispatched: boolean
  reason: string
  artifactPath?: string
  dispatchedAt: string
}

/**
 * NoopDispatcher — Phase 1 default. Records the exact dispatch request as
 * dispatch-request.json so Phase 2 can replay it. Never edits files, never
 * starts an agent.
 */
export class NoopDispatcher implements RemediationDispatcher {
  readonly name = "noop"
  constructor(
    private readonly writeArtifact: (name: string, content: string) => Promise<string>,
  ) {}

  async dispatch(input: RemediationDispatchInput): Promise<RemediationDispatchResult> {
    const payload = {
      dispatcher: this.name,
      dispatchedAt: new Date().toISOString(),
      dryRun: input.dryRun,
      incident: {
        id: input.incident.incidentId,
        issueType: input.incident.issueType,
        severity: input.incident.severity,
        primaryNodeId: input.incident.primaryNodeId,
        failingEdgeId: input.incident.failingEdgeId,
        errorId: input.incident.errorId,
      },
      neat: {
        baseUrl: input.graphContext.neat.baseUrl,
        project: input.graphContext.neat.project,
      },
      plan: {
        issueClass: input.plan.issueClass,
        strategy: input.plan.strategy.name,
        agentTasks: input.plan.strategy.agentTasks,
        nextAction: input.plan.nextAction,
      },
      candidateFiles: input.candidateFiles,
      constraints: input.constraints,
      safetyRules: input.safetyRules,
      requestedOutputs: input.requestedOutputs,
      note:
        "Phase 1 dispatcher is a no-op. This file records what Phase 2's OpenCodeSessionDispatcher would receive. No files were modified, no agent was started.",
    }
    const path = await this.writeArtifact("dispatch-request.json", JSON.stringify(payload, null, 2) + "\n")
    return {
      dispatched: false,
      reason: input.dryRun
        ? "dry-run: dispatcher is noop; request recorded as dispatch-request.json"
        : "Phase 1: only noop dispatcher is implemented",
      artifactPath: path,
      dispatchedAt: payload.dispatchedAt,
    }
  }
}

export function buildSafetyRules(riskGates: GateResult[], policy: PolicyGateResult): SafetyRules {
  return {
    forbidDestructiveOps: true,
    forbidExternalDirectoryWrites: true,
    forbidShellWithoutAllowlist: true,
    blockingRiskGates: riskGates.filter((g) => g.status === "block" || g.status === "requires_approval").map((g) => g.gateId),
    blockingPolicyViolations: policy.blockingViolations.length,
  }
}
