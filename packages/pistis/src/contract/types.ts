/**
 * Pistis contract types. Match the shapes in the Pistis contract-driven prompt
 * exactly so the artifact format is stable across phases.
 *
 *  AgentContract  : Sonnet/Pistis tells a worker what to do, with bounds.
 *  AgentResult    : worker reports back, structured.
 *  ContractReview : Sonnet/Pistis decides accept / retry / reject / escalate.
 *
 * Phase 2 ships exactly one worker role ("patch"). Phase 3 introduces the
 * full role catalogue (graph-context, root-cause, patch, test, reviewer,
 * security-risk, migration, pr).
 */

export interface AgentContract {
  /** Stable id: `${incidentId}::${agentRole}::${seq}`. */
  contractId: string
  agentRole: string
  objective: string
  /**
   * Pass-through graph context the worker may consult. Treated as opaque by
   * the worker; Pistis owns the shape.
   */
  graphContext: unknown
  allowedFiles: string[]
  forbiddenFiles: string[]
  constraints: string[]
  successCriteria: string[]
  requiredOutputs: string[]
  validationCommands: string[]
  maxRetries: number
  /**
   * Phase 3: structured inputs from upstream orchestration steps. `priorFindings`
   * is a role→AgentResult map; the worker may reference earlier agents' summaries
   * and risk notes but must not assume their diffs are still in the workspace
   * (the orchestrator may reset between roles).
   */
  inputs?: {
    priorFindings?: Record<string, AgentResult>
    [key: string]: unknown
  }
}

export interface AgentResult {
  contractId: string
  status: "completed" | "failed" | "blocked"
  summary: string
  filesChanged: string[]
  testsRun: string[]
  diff?: string
  riskNotes: string[]
  unresolvedQuestions: string[]
}

export interface ContractReview {
  contractId: string
  verdict: "accepted" | "rejected" | "needs_retry" | "needs_human"
  reasons: string[]
  criteriaResults: CriterionResult[]
  /** Refined prompt to send next time the same worker is invoked. Present only when verdict === "needs_retry". */
  nextPrompt?: string
}

export interface CriterionResult {
  criterion: string
  status: "pass" | "fail" | "unknown"
  evidence: string[]
}
