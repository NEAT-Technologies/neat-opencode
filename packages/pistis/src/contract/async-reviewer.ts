import type { ContractReview } from "./types"
import type { ContractReviewer, ContractReviewerInput } from "./reviewer"
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

/**
 * Adapter that lifts a sync ContractReviewer into the AsyncContractReviewer
 * shape. Lets the orchestrator's internal review path stay uniformly async
 * regardless of which reviewer the caller wired in.
 *
 * The async input is a superset of the sync input, so the adapter just
 * forwards the base fields and drops the extras (incident / graphContext /
 * primaryNodeId) that the sync reviewer doesn't use.
 */
export class SyncToAsyncReviewerAdapter implements AsyncContractReviewer {
  readonly name: string
  constructor(private readonly inner: ContractReviewer) {
    this.name = `async(${inner.name})`
  }
  async review(input: AsyncContractReviewerInput): Promise<ContractReview> {
    return this.inner.review(input)
  }
}
