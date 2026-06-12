import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { GateResult } from "../validation/risk-gate"
import type { PolicyGateResult } from "../validation/policy-gate"
import type { AgentContract } from "../contract/types"
import { buildAgentContract } from "../contract/builder"

/**
 * Dispatcher contract.
 *
 * Implementations:
 *   - NoopDispatcher              (Phase 1 default, --dry-run)
 *   - OpenCodeSessionDispatcher   (Phase 2: runs one worker per AgentContract,
 *                                  reviews against successCriteria, retries
 *                                  with refined prompts)
 *
 * Interface stability is the point: planner/context code never changes
 * between phases. The dispatcher swap is the only knob.
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
  /** Risk gate results — used to seed forbiddenFiles in the first AgentContract. */
  riskGates?: GateResult[]
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
 * NoopDispatcher — Phase 1 default. Writes `dispatch-request.json` shaped as
 * the FIRST AgentContract (per the contract-driven prompt: "Phase 1's
 * dispatch-request.json should represent the first version of an
 * AgentContract"). Never edits files, never starts an agent.
 */
export class NoopDispatcher implements RemediationDispatcher {
  readonly name = "noop"
  constructor(
    private readonly writeArtifact: (name: string, content: string) => Promise<string>,
  ) {}

  async dispatch(input: RemediationDispatchInput): Promise<RemediationDispatchResult> {
    const contract: AgentContract = buildAgentContract({
      incident: input.incident,
      graph: input.graphContext,
      plan: input.plan,
      classification: { class: input.plan.issueClass, reasons: [], confidence: "high" },
      riskGates: input.riskGates ?? [],
      testCommands: input.constraints.testCommands,
    })

    const envelope = {
      dispatcher: this.name,
      dispatchedAt: new Date().toISOString(),
      dryRun: input.dryRun,
      safetyRules: input.safetyRules,
      requestedOutputs: input.requestedOutputs,
      contract,
      note:
        "NoopDispatcher recorded the first AgentContract that would be sent to a worker. No sandbox was spawned, no worker was started, no files were modified.",
    }
    const path = await this.writeArtifact("dispatch-request.json", JSON.stringify(envelope, null, 2) + "\n")
    return {
      dispatched: false,
      reason: input.dryRun
        ? "dry-run: dispatcher is noop; first AgentContract recorded as dispatch-request.json"
        : "noop dispatcher: no worker is wired",
      artifactPath: path,
      dispatchedAt: envelope.dispatchedAt,
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
