import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { MultiAgentOrchestrator } from "../src/orchestration/orchestrator"
import { buildOrchestrationPlan } from "../src/orchestration/plan"
import { MultiRoleStubWorker } from "../src/orchestration/role-worker"
import { RuleBasedContractReviewer } from "../src/contract/reviewer"
import { SyncToAsyncReviewerAdapter } from "../src/contract/async-reviewer"
import type { AsyncContractReviewer, AsyncContractReviewerInput } from "../src/contract/async-reviewer"
import { normalizeIncident } from "../src/incident/schema"
import { buildPlan } from "../src/planner/remediation-plan"
import { classifyIncident } from "../src/planner/classifier"
import type { GraphContext } from "../src/neat/context-builder"
import type { ContractReview } from "../src/contract/types"

function sh(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd, stdio: "ignore" })
    c.on("close", (code) => res(code ?? -1))
    c.on("error", () => res(-1))
  })
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pistis-asyncrev-"))
  await sh("git", ["init", "-q", "-b", "main"], dir)
  await sh("git", ["config", "user.email", "p@p"], dir)
  await sh("git", ["config", "user.name", "p"], dir)
  await fs.mkdir(join(dir, "src"), { recursive: true })
  await fs.writeFile(join(dir, "src/app.ts"), "// original\n")
  await fs.writeFile(join(dir, "README.md"), "hello\n")
  await sh("git", ["add", "."], dir)
  await sh("git", ["commit", "-q", "-m", "init"], dir)
  return dir
}

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "svc:app", fetched: true },
    incident: { id: "INC", issueType: "runtime_exception", severity: "medium", message: "", evidence: [], candidateFiles: [], labels: [] },
    sections: {
      edges: { status: "unavailable", endpoint: "u", error: "n/a" },
      rootCause: { status: "unavailable", endpoint: "u", error: "n/a" },
      blastRadius: { status: "unavailable", endpoint: "u", error: "n/a" },
      dependencies: { status: "unavailable", endpoint: "u", error: "n/a" },
      divergences: { status: "unavailable", endpoint: "u", error: "n/a" },
      incidentsForNode: { status: "unavailable", endpoint: "u", error: "n/a" },
      policyViolations: { status: "unavailable", endpoint: "u", error: "n/a" },
    },
    unavailable: [],
  }
}

/**
 * Recording async reviewer: returns a configurable verdict and records
 * every call so tests can assert which roles were routed to it.
 */
function recordingAsyncReviewer(
  fixedVerdict: ContractReview["verdict"],
): { reviewer: AsyncContractReviewer; calls: AsyncContractReviewerInput[] } {
  const calls: AsyncContractReviewerInput[] = []
  const reviewer: AsyncContractReviewer = {
    name: "recording-async",
    async review(input: AsyncContractReviewerInput): Promise<ContractReview> {
      calls.push(input)
      return {
        contractId: input.contract.contractId,
        verdict: fixedVerdict,
        reasons: ["recording reviewer fixed verdict"],
        criteriaResults: [],
      }
    },
  }
  return { reviewer, calls }
}

describe("MultiAgentOrchestrator + AsyncContractReviewer", () => {
  test("Test 9/10: asyncReviewer is used for file-writing roles only; sync handles reasoning roles", async () => {
    const dir = await initRepo()
    try {
      const writes: Record<string, string> = {}
      const incident = normalizeIncident({
        incidentId: "INC-ROUTE",
        primaryNodeId: "svc:app",
        issueType: "runtime_exception",
        candidateFiles: ["src/app.ts"],
      })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      const async = recordingAsyncReviewer("accepted")
      const orch = new MultiAgentOrchestrator({
        worker: new MultiRoleStubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        asyncReviewer: async.reviewer,
        workspaceCwd: dir,
        writeArtifact: async (n, c) => { writes[n] = c; return `/w/${n}` },
      })
      const summary = await orch.run({
        incident, graph, plan, classification: cl, riskGates: [], testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      const calledRoles = async.calls.map((c) => c.contract.agentRole).sort()
      // Routed: patch only (it's the only file-writing role in runtime_exception plan).
      expect(calledRoles).toEqual(["patch"])
      // graph_context, root_cause, security_risk, reviewer (and test) ran through sync.
      expect(calledRoles).not.toContain("graph_context")
      expect(calledRoles).not.toContain("root_cause")
      expect(calledRoles).not.toContain("security_risk")
      expect(summary.finalVerdict).toBe("accepted")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Test 11: orchestration summary structure is identical regardless of which reviewer ran", async () => {
    const dir = await initRepo()
    try {
      const incident = normalizeIncident({
        incidentId: "INC-SCHEMA",
        primaryNodeId: "svc:app",
        issueType: "runtime_exception",
        candidateFiles: ["src/app.ts"],
      })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      const async = recordingAsyncReviewer("accepted")
      const orchWithAsync = new MultiAgentOrchestrator({
        worker: new MultiRoleStubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        asyncReviewer: async.reviewer,
        workspaceCwd: dir,
        writeArtifact: async () => "/w",
      })
      const summaryAsync = await orchWithAsync.run({
        incident, graph, plan, classification: cl, riskGates: [], testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      expect(typeof summaryAsync.finalVerdict).toBe("string")
      expect(typeof summaryAsync.totalAttempts).toBe("number")
      expect(typeof summaryAsync.workspaceCwd).toBe("string")
      expect(summaryAsync.roleResults.patch).toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Test 12: asyncReviewer receives incident + graphContext + primaryNodeId", async () => {
    const dir = await initRepo()
    try {
      const incident = normalizeIncident({
        incidentId: "INC-CTX",
        primaryNodeId: "svc:app",
        issueType: "runtime_exception",
        candidateFiles: ["src/app.ts"],
      })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      const async = recordingAsyncReviewer("accepted")
      const orch = new MultiAgentOrchestrator({
        worker: new MultiRoleStubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        asyncReviewer: async.reviewer,
        workspaceCwd: dir,
        writeArtifact: async () => "/w",
      })
      await orch.run({
        incident, graph, plan, classification: cl, riskGates: [], testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      const patchCall = async.calls.find((c) => c.contract.agentRole === "patch")
      expect(patchCall).toBeDefined()
      expect(patchCall!.incident.incidentId).toBe("INC-CTX")
      expect(patchCall!.graphContext).toBeDefined()
      expect(patchCall!.primaryNodeId).toBe("svc:app")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Test 10 (no async): without asyncReviewer, the sync reviewer is used for every step", async () => {
    const dir = await initRepo()
    try {
      const writes: Record<string, string> = {}
      const incident = normalizeIncident({
        incidentId: "INC-SYNC",
        primaryNodeId: "svc:app",
        issueType: "runtime_exception",
        candidateFiles: ["src/app.ts"],
      })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      const orch = new MultiAgentOrchestrator({
        worker: new MultiRoleStubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async (n, c) => { writes[n] = c; return `/w/${n}` },
      })
      const summary = await orch.run({
        incident, graph, plan, classification: cl, riskGates: [], testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      expect(summary.finalVerdict).toBe("accepted")
      expect(Object.keys(summary.roleResults)).toContain("patch")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Test 13: SyncToAsyncReviewerAdapter forwards the inner reviewer's verdict", async () => {
    const inner = new RuleBasedContractReviewer()
    const adapter = new SyncToAsyncReviewerAdapter(inner)
    expect(adapter.name).toBe("async(rule-based)")

    const result = await adapter.review({
      contract: {
        contractId: "INC::patch::000",
        agentRole: "patch",
        objective: "x",
        graphContext: {},
        allowedFiles: ["src/app.ts"],
        forbiddenFiles: [],
        constraints: [],
        successCriteria: ["at least one file changed"],
        requiredOutputs: [],
        validationCommands: [],
        maxRetries: 1,
      },
      result: {
        contractId: "INC::patch::000",
        status: "completed",
        summary: "x",
        filesChanged: ["src/app.ts"],
        testsRun: [],
        riskNotes: [],
        unresolvedQuestions: [],
      },
      incident: normalizeIncident({ incidentId: "INC", primaryNodeId: "n", candidateFiles: ["src/app.ts"] }),
      graphContext: fakeGraph(),
      primaryNodeId: "n",
    })
    expect(result.verdict).toBe("accepted")
  })
})
