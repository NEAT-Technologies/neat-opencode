import type { AgentContract, AgentResult } from "../contract/types"
import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { Classification } from "../planner/classifier"
import type { GateResult } from "../validation/risk-gate"
import type { AgentRole } from "./roles"
import { buildAgentContract } from "../contract/builder"

/**
 * Per-role contract builders. Each role inherits the base "patch" contract
 * (path bounds, forbidden patterns, retries) but overrides:
 *   - agentRole
 *   - objective
 *   - successCriteria (what "done" means for this role)
 *   - requiredOutputs
 *   - allowedFiles (empty for non-file-writing roles)
 *   - validationCommands (only test/reviewer roles run them)
 *
 * `priorFindings` is the role→AgentResult map from previously completed steps,
 * folded into the contract so the worker can reference upstream summaries.
 */

export interface RoleContractInput {
  role: AgentRole
  sequence: number
  incident: NormalizedIncident
  graph: GraphContext
  plan: RemediationPlan
  classification: Classification
  riskGates: GateResult[]
  testCommands: string[]
  priorFindings: Record<string, AgentResult>
  maxRetries?: number
}

export function buildRoleContract(input: RoleContractInput): AgentContract {
  const base = buildAgentContract({
    incident: input.incident,
    graph: input.graph,
    plan: input.plan,
    classification: input.classification,
    riskGates: input.riskGates,
    testCommands: input.role === "test" || input.role === "reviewer" ? input.testCommands : [],
    sequence: input.sequence,
    maxRetries: input.maxRetries ?? 2,
    agentRole: input.role,
  })

  const overrides = ROLE_OVERRIDES[input.role](base, input)
  return {
    ...base,
    ...overrides,
    inputs: { ...(base.inputs ?? {}), priorFindings: input.priorFindings },
  }
}

type RoleOverrideFn = (
  base: AgentContract,
  input: RoleContractInput,
) => Partial<AgentContract>

const ROLE_OVERRIDES: Record<AgentRole, RoleOverrideFn> = {
  graph_context: (_base, input) => ({
    objective:
      `Summarize the NEAT graph context for incident ${input.incident.incidentId}: which nodes/edges are implicated, ` +
      `blast radius, divergences, policy state. Do not propose a fix.`,
    allowedFiles: [],
    forbiddenFiles: [],
    successCriteria: [
      "AgentResult.summary explains the graph signal in 3+ sentences.",
      "filesChanged is empty.",
    ],
    requiredOutputs: ["agent-result.json"],
    validationCommands: [],
  }),

  root_cause: (_base, input) => ({
    objective:
      `Given the graph context summary, identify the most likely root cause for incident ${input.incident.incidentId}. ` +
      `Reference NEAT root-cause hints from priorFindings.graph_context. Do not modify files.`,
    allowedFiles: [],
    forbiddenFiles: [],
    successCriteria: [
      "AgentResult.summary states the root cause hypothesis.",
      "filesChanged is empty.",
    ],
    requiredOutputs: ["agent-result.json"],
    validationCommands: [],
  }),

  patch: (base, _input) => ({
    // base from buildAgentContract is already patch-shaped. Keep its
    // successCriteria; just add the inter-agent context expectation.
    objective:
      base.objective +
      `\n\nUse priorFindings.root_cause.summary as your starting hypothesis. ` +
      `Stay within allowedFiles; never touch forbiddenFiles.`,
  }),

  test: (_base, input) => ({
    objective:
      `Run the configured validation commands (${input.testCommands.length} command(s)) and report results. ` +
      `Do not modify files. Surface any failures via unresolvedQuestions.`,
    allowedFiles: [],
    forbiddenFiles: [],
    successCriteria: [
      "AgentResult.testsRun lists each validation command and its exit code.",
      `All validation commands exit zero: ${input.testCommands.map((c) => `\`${c}\``).join(", ") || "(none)"}.`,
    ],
    requiredOutputs: ["test-report.txt", "agent-result.json"],
    validationCommands: input.testCommands,
  }),

  reviewer: (_base, input) => ({
    objective:
      `Final review of the patch and test results from priorFindings. ` +
      `Confirm the change addresses the root cause and does not introduce regressions. Do not modify files.`,
    allowedFiles: [],
    forbiddenFiles: [],
    successCriteria: [
      "AgentResult.summary states a clear accept/reject recommendation.",
      "filesChanged is empty.",
      ...(input.testCommands.length > 0
        ? [`Reviewer cross-checks that all validation commands exit zero: ${input.testCommands.map((c) => `\`${c}\``).join(", ")}.`]
        : []),
    ],
    requiredOutputs: ["agent-result.json"],
    validationCommands: [],
  }),

  security_risk: (_base, _input) => ({
    objective:
      `Inspect the patch from priorFindings.patch for security-sensitive patterns: new secrets in code, ` +
      `auth bypass paths, sql injection, broad permission widening. Do not modify files. Add findings to riskNotes.`,
    allowedFiles: [],
    forbiddenFiles: [],
    successCriteria: [
      "AgentResult.riskNotes is populated (may be empty array; must be present).",
      "filesChanged is empty.",
    ],
    requiredOutputs: ["agent-result.json"],
    validationCommands: [],
  }),

  migration: (base, _input) => ({
    objective:
      base.objective +
      `\n\nThis incident is a db_schema_or_query class. Draft a migration file under \`migrations/\`. ` +
      `Do not execute the migration. Surface the migration content in the diff for human approval.`,
    allowedFiles: [...base.allowedFiles, "migrations/"],
    // Tightened constraint: migration role *may* write into migrations/, but
    // patch role is forbidden from doing so. Strip it from forbidden here.
    forbiddenFiles: base.forbiddenFiles.filter((f) => !/migrations/i.test(f)),
    constraints: [
      ...base.constraints,
      "Never run the migration. Surface intended SQL in the migration file only.",
    ],
  }),
}
