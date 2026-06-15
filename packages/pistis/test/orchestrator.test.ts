import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { MultiAgentOrchestrator } from "../src/orchestration/orchestrator"
import { buildOrchestrationPlan } from "../src/orchestration/plan"
import { MultiRoleStubWorker } from "../src/orchestration/role-worker"
import { RuleBasedContractReviewer } from "../src/contract/reviewer"
import { normalizeIncident } from "../src/incident/schema"
import { buildPlan } from "../src/planner/remediation-plan"
import { classifyIncident } from "../src/planner/classifier"
import type { GraphContext } from "../src/neat/context-builder"

function sh(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd, stdio: "ignore" })
    c.on("close", (code) => res(code ?? -1))
    c.on("error", () => res(-1))
  })
}

async function initRepo(seedSrc = true): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pistis-orch-"))
  await sh("git", ["init", "-q", "-b", "main"], dir)
  await sh("git", ["config", "user.email", "p@p"], dir)
  await sh("git", ["config", "user.name", "p"], dir)
  if (seedSrc) {
    await fs.mkdir(join(dir, "src"), { recursive: true })
    await fs.writeFile(join(dir, "src/app.ts"), "// original\n")
  }
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

describe("MultiAgentOrchestrator", () => {
  test("runs the full runtime_exception plan and accepts", async () => {
    const dir = await initRepo()
    try {
      const writes: Record<string, string> = {}
      const incident = normalizeIncident({
        incidentId: "INC-O",
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
        incident, graph, plan, classification: cl, riskGates: [],
        testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      expect(summary.finalVerdict).toBe("accepted")
      expect(Object.keys(summary.roleResults)).toEqual([
        "graph_context", "root_cause", "patch", "test", "security_risk", "reviewer",
      ])
      // per-role artifacts written
      expect(writes["graph_context/001/contract.json"]).toBeDefined()
      expect(writes["graph_context/001/agent-result.json"]).toBeDefined()
      expect(writes["graph_context/001/contract-review.json"]).toBeDefined()
      expect(writes["patch/001/patch.diff"]).toBeDefined()
      // top-level patch.diff for convenience
      expect(writes["patch.diff"]).toBeDefined()
      // orchestration-summary.json at top level
      expect(writes["orchestration-summary.json"]).toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("runs the db_schema_or_query plan and produces a migration file", async () => {
    const dir = await initRepo(false)
    try {
      const writes: Record<string, string> = {}
      const incident = normalizeIncident({
        incidentId: "INC-DB",
        primaryNodeId: "svc:db",
        issueType: "db_schema_or_query",
        candidateFiles: ["src/db.ts"],
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
        incident, graph, plan, classification: cl, riskGates: [],
        testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      expect(Object.keys(summary.roleResults)).toContain("migration")
      expect(Object.keys(summary.roleResults)).not.toContain("patch")
      // migration file should exist on disk
      const files = await fs.readdir(join(dir, "migrations"))
      expect(files.some((f) => f.endsWith(".sql"))).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("halts when a role's review is rejected", async () => {
    const dir = await initRepo()
    try {
      // Force the patch role to touch a forbidden file by using a worker that
      // does that. We swap MultiRoleStubWorker's patch behaviour via a small
      // shim worker class.
      const Worker = {
        name: "shim",
        async run(contract: import("../src/contract/types").AgentContract, ws: { cwd: string; isGitRepo: boolean }) {
          const inner = new MultiRoleStubWorker()
          if (contract.agentRole === "patch") {
            // touch .env (in forbiddenFiles)
            await fs.writeFile(join(ws.cwd, ".env"), "x=y\n", "utf8")
            const base = await inner.run(contract, ws)
            return { ...base, filesChanged: [...base.filesChanged, ".env"] }
          }
          return inner.run(contract, ws)
        },
      }
      const writes: Record<string, string> = {}
      const incident = normalizeIncident({
        incidentId: "INC-REJ",
        primaryNodeId: "svc:app",
        issueType: "runtime_exception",
        candidateFiles: ["src/app.ts"],
      })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      const orch = new MultiAgentOrchestrator({
        worker: Worker,
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async (n, c) => { writes[n] = c; return `/w/${n}` },
      })
      const summary = await orch.run({
        incident, graph, plan, classification: cl, riskGates: [],
        testCommands: [],
        orchestrationPlan: buildOrchestrationPlan(cl),
      })
      expect(["rejected", "needs_human"]).toContain(summary.finalVerdict)
      // halted before reviewer
      expect(Object.keys(summary.roleResults)).not.toContain("reviewer")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses dirty workspace", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "README.md"), "dirty\n")
      const orch = new MultiAgentOrchestrator({
        worker: new MultiRoleStubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async () => "/x",
      })
      const incident = normalizeIncident({ incidentId: "X", primaryNodeId: "n", candidateFiles: ["src/app.ts"] })
      const graph = fakeGraph()
      const cl = classifyIncident(incident, graph)
      const plan = buildPlan(incident, graph, cl, { testCommands: [] })
      await expect(
        orch.run({
          incident, graph, plan, classification: cl, riskGates: [],
          testCommands: [],
          orchestrationPlan: buildOrchestrationPlan(cl),
        }),
      ).rejects.toThrow(/uncommitted/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
