import { describe, expect, test } from "bun:test"
import { RouterWorker } from "../src/workers/router-worker"
import { OutOfRoleError } from "../src/workers/errors"
import type { Worker, WorkerWorkspace } from "../src/opencode/worker"
import type { AgentContract, AgentResult } from "../src/contract/types"

function recordingWorker(name: string): { worker: Worker; calls: AgentContract[] } {
  const calls: AgentContract[] = []
  const worker: Worker = {
    name,
    async run(contract: AgentContract): Promise<AgentResult> {
      calls.push(contract)
      return {
        contractId: contract.contractId,
        status: "completed",
        summary: `${name} ran for ${contract.agentRole}`,
        filesChanged: [],
        testsRun: [],
        riskNotes: [],
        unresolvedQuestions: [],
      }
    },
  }
  return { worker, calls }
}

function contractFor(role: string, validationCommands: string[] = []): AgentContract {
  return {
    contractId: `INC-T::${role}::000`,
    agentRole: role,
    objective: "test",
    graphContext: {},
    allowedFiles: [],
    forbiddenFiles: [],
    constraints: [],
    successCriteria: [],
    requiredOutputs: [],
    validationCommands,
    maxRetries: 1,
  }
}

const WORKSPACE: WorkerWorkspace = { cwd: "/tmp", isGitRepo: true }

describe("RouterWorker", () => {
  test("graph_context → flashWorker, minimax not called", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    const out = await r.run(contractFor("graph_context"), WORKSPACE)
    expect(out.summary).toContain("flash ran for graph_context")
    expect(flash.calls.length).toBe(1)
    expect(minimax.calls.length).toBe(0)
  })

  test("root_cause → flashWorker", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    await r.run(contractFor("root_cause"), WORKSPACE)
    expect(flash.calls.length).toBe(1)
    expect(minimax.calls.length).toBe(0)
  })

  test("security_risk → flashWorker", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    await r.run(contractFor("security_risk"), WORKSPACE)
    expect(flash.calls.length).toBe(1)
    expect(minimax.calls.length).toBe(0)
  })

  test("patch → minimaxWorker, flash not called", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    const out = await r.run(contractFor("patch"), WORKSPACE)
    expect(out.summary).toContain("minimax ran for patch")
    expect(minimax.calls.length).toBe(1)
    expect(flash.calls.length).toBe(0)
  })

  test("migration → minimaxWorker", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    await r.run(contractFor("migration"), WORKSPACE)
    expect(minimax.calls.length).toBe(1)
    expect(flash.calls.length).toBe(0)
  })

  test("test role → synthetic AgentResult, no sub-worker called", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    const out = await r.run(contractFor("test", ["npm test", "npm run lint"]), WORKSPACE)
    expect(out.status).toBe("completed")
    expect(out.testsRun).toEqual(["npm test", "npm run lint"])
    expect(flash.calls.length).toBe(0)
    expect(minimax.calls.length).toBe(0)
  })

  test("reviewer role → OutOfRoleError, no sub-worker called", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    await expect(r.run(contractFor("reviewer"), WORKSPACE)).rejects.toBeInstanceOf(OutOfRoleError)
    expect(flash.calls.length).toBe(0)
    expect(minimax.calls.length).toBe(0)
  })

  test("unknown role → failed AgentResult, no sub-worker called", async () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    const out = await r.run(contractFor("totally_made_up_role"), WORKSPACE)
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/no route for role: totally_made_up_role/)
    expect(flash.calls.length).toBe(0)
    expect(minimax.calls.length).toBe(0)
  })

  test("RouterWorker.name is 'router'", () => {
    const flash = recordingWorker("flash")
    const minimax = recordingWorker("minimax")
    const r = new RouterWorker({ flashWorker: flash.worker, minimaxWorker: minimax.worker })
    expect(r.name).toBe("router")
  })
})
