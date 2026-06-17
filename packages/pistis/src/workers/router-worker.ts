import type { Worker, WorkerWorkspace } from "../opencode/worker"
import type { AgentContract, AgentResult } from "../contract/types"
import { OutOfRoleError } from "./errors"

const FLASH_ROLES = new Set(["graph_context", "root_cause", "security_risk"])
const MINIMAX_ROLES = new Set(["patch", "migration"])

export interface RouterWorkerOptions {
  /** Handles graph_context, root_cause, security_risk. */
  flashWorker: Worker
  /** Handles patch, migration. */
  minimaxWorker: Worker
}

/**
 * RouterWorker — dispatches by `contract.agentRole` to the worker that knows
 * how to handle that role. Reasoning roles go to Flash; code-writing roles
 * go to MiniMax; `test` returns a synthetic AgentResult declaring the commands
 * (the orchestrator runs them itself); `reviewer` is never dispatched as a
 * worker step in plans produced by buildOrchestrationPlan, so reaching this
 * worker with `reviewer` is a programmer error and throws OutOfRoleError.
 *
 * The router is stateless. It does no caching, no retries, no logging —
 * those are concerns of the inner workers (which already have their own
 * transient-retry policy) and the orchestrator.
 */
export class RouterWorker implements Worker {
  readonly name = "router"

  constructor(private readonly opts: RouterWorkerOptions) {}

  async run(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
    const role = contract.agentRole
    if (FLASH_ROLES.has(role)) {
      return this.opts.flashWorker.run(contract, workspace)
    }
    if (MINIMAX_ROLES.has(role)) {
      return this.opts.minimaxWorker.run(contract, workspace)
    }
    if (role === "test") {
      return {
        contractId: contract.contractId,
        status: "completed",
        summary: `Test role: declared ${contract.validationCommands.length} validation command(s) for the orchestrator to run.`,
        filesChanged: [],
        testsRun: [...contract.validationCommands],
        riskNotes: [],
        unresolvedQuestions: [],
      }
    }
    if (role === "reviewer") {
      throw new OutOfRoleError(role, this.name)
    }
    return {
      contractId: contract.contractId,
      status: "failed",
      summary: `RouterWorker has no route for role: ${role}`,
      filesChanged: [],
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: [`add a route for ${role} or update the orchestration plan`],
    }
  }
}
