import type { AgentContract, AgentResult } from "../contract/types"

/**
 * Worker contract: receive an AgentContract + a workspace, return an AgentResult.
 *
 * Phase 2 ships:
 *   - StubWorker        : deterministic, used for tests and as the default
 *                         when no real OpenCode session is wired.
 *   - OpenCodeWorker    : thin stub that, when implemented, will spawn an
 *                         OpenCode child session. Phase 2 leaves the body
 *                         marked `notImplemented()` so the wiring can be done
 *                         in a follow-up without changing the interface.
 *
 * The Worker MUST NOT touch files outside `workspace.cwd`. The Worker MUST
 * NOT exceed `contract.allowedFiles` (the dispatcher verifies this).
 */
export interface Worker {
  readonly name: string
  run(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult>
}

export interface WorkerWorkspace {
  /** Absolute path the worker may read/write within. */
  cwd: string
  /** Whether `cwd` is a git repository (informational; the dispatcher decides what to do with this). */
  isGitRepo: boolean
}

export class WorkerNotImplementedError extends Error {
  override readonly name = "WorkerNotImplementedError"
}
