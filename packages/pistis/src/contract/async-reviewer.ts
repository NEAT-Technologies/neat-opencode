import type { ContractReview } from "./types"
import type { ContractReviewerInput } from "./reviewer"
import type { GraphContext } from "../neat/context-builder"
import type { NormalizedIncident } from "../incident/schema"

/**
 * Input for an async (LLM-backed) reviewer. Extends the sync ContractReviewerInput
 * with the additional context an LLM needs to reason about implications:
 * the normalized incident, the full graph context Flash captured, and the
 * primary node id (used as a default arg for tool calls).
 */
export interface AsyncContractReviewerInput extends ContractReviewerInput {
  incident: NormalizedIncident
  graphContext: GraphContext
  primaryNodeId: string
}

/**
 * Async counterpart to ContractReviewer. The existing sync ContractReviewer
 * interface stays unchanged so RuleBasedContractReviewer and the existing
 * orchestrator integration keep working. The router worker in Phase 4D
 * introduces an adapter so the orchestrator can dispatch to either.
 */
export interface AsyncContractReviewer {
  readonly name: string
  review(input: AsyncContractReviewerInput): Promise<ContractReview>
}
