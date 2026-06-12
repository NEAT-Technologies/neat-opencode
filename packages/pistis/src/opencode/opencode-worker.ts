import type { Worker, WorkerWorkspace } from "./worker"
import { WorkerNotImplementedError } from "./worker"
import type { AgentContract, AgentResult } from "../contract/types"

/**
 * OpenCodeWorker — spawns a real OpenCode child session to satisfy the
 * contract. Phase 2 leaves the body as `WorkerNotImplementedError` because
 * the exact OpenCode session-spawn API is one of the items the contract
 * prompt lists as "Important Unknowns to Resolve by Inspection."
 *
 * The interface is stable so the wiring is a follow-up patch, not a
 * dispatcher rewrite. To wire it:
 *   1. Import @opencode-ai/sdk's session constructor.
 *   2. Build a system prompt from `contract.objective`, `constraints`,
 *      `successCriteria`, and `requiredOutputs`.
 *   3. Restrict tool permissions so allowedFiles/forbiddenFiles are
 *      honored at the tool layer.
 *   4. Run the session, collect the final assistant summary +
 *      tool-call file list, and translate into AgentResult.
 *
 * Pistis's dispatcher does NOT depend on which worker is used; tests stay
 * on StubWorker and production wiring lands here without changing flows.
 */
export interface OpenCodeWorkerOptions {
  /** Reserved: model id, provider creds, system prompt overlay, etc. */
  model?: string
  systemPromptOverlay?: string
  /** Reserved: max tool calls / iterations inside the OpenCode session. */
  maxIterations?: number
}

export class OpenCodeWorker implements Worker {
  readonly name = "opencode"
  constructor(private readonly _opts: OpenCodeWorkerOptions = {}) {}

  async run(_contract: AgentContract, _workspace: WorkerWorkspace): Promise<AgentResult> {
    throw new WorkerNotImplementedError(
      "OpenCodeWorker is not wired to the OpenCode SDK yet. Use --worker=stub for now, or wire @opencode-ai/sdk session spawn into OpenCodeWorker.run(). See packages/pistis/src/opencode/opencode-worker.ts for the integration plan.",
    )
  }
}
