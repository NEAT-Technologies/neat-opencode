import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { OpenCodeSessionDispatcher } from "../src/opencode/opencode-session-dispatcher"
import { StubWorker } from "../src/opencode/stub-worker"
import { RuleBasedContractReviewer } from "../src/contract/reviewer"
import { normalizeIncident } from "../src/incident/schema"
import { buildPlan } from "../src/planner/remediation-plan"
import { classifyIncident } from "../src/planner/classifier"
import type { GraphContext } from "../src/neat/context-builder"
import type { RemediationDispatchInput } from "../src/opencode/dispatcher"

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "n", fetched: true },
    incident: { id: "INC", issueType: "x", severity: "medium", message: "", evidence: [], candidateFiles: [], labels: [] },
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

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" })
    child.on("close", (code) => resolve(code ?? -1))
    child.on("error", () => resolve(-1))
  })
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pistis-disp-"))
  await run("git", ["init", "-q", "-b", "main"], dir)
  await run("git", ["config", "user.email", "p@p"], dir)
  await run("git", ["config", "user.name", "p"], dir)
  await fs.writeFile(join(dir, "README.md"), "hello\n")
  await fs.mkdir(join(dir, "src"), { recursive: true })
  await fs.writeFile(join(dir, "src/a.ts"), "// original\n")
  await run("git", ["add", "."], dir)
  await run("git", ["commit", "-q", "-m", "init"], dir)
  return dir
}

function makeInput(workspaceCwd: string): RemediationDispatchInput {
  const incident = normalizeIncident({
    incidentId: "INC-D",
    primaryNodeId: "n",
    issueType: "runtime_exception",
    candidateFiles: ["src/a.ts"],
  })
  const graph = fakeGraph()
  const cls = classifyIncident(incident, graph)
  const plan = buildPlan(incident, graph, cls, { testCommands: [] })
  return {
    incident,
    graphContext: graph,
    plan,
    candidateFiles: incident.candidateFiles,
    constraints: { timeoutMs: 30_000, maxFiles: 25, testCommands: [] },
    safetyRules: {
      forbidDestructiveOps: true,
      forbidExternalDirectoryWrites: true,
      forbidShellWithoutAllowlist: true,
      blockingRiskGates: [],
      blockingPolicyViolations: 0,
    },
    requestedOutputs: { patchDiff: true, agentEventsJsonl: false, sessionTranscript: false },
    dryRun: false,
    riskGates: [],
  }
}

describe("OpenCodeSessionDispatcher", () => {
  test("accepted end-to-end with StubWorker on a real git repo", async () => {
    const dir = await initRepo()
    try {
      const writes: Record<string, string> = {}
      const d = new OpenCodeSessionDispatcher({
        worker: new StubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async (n, c) => { writes[n] = c; return `/w/${n}` },
      })
      const r = await d.dispatch(makeInput(dir))
      expect(r.dispatched).toBe(true)
      expect(r.reason).toContain("accepted")
      expect(writes["contract-001.json"]).toBeDefined()
      expect(writes["agent-result-001.json"]).toBeDefined()
      expect(writes["contract-review-001.json"]).toBeDefined()
      expect(writes["patch.diff"]).toBeDefined()
      expect(writes["patch.diff"]!).toContain("--- a/src/a.ts")
      expect(writes["dispatch-summary.json"]).toBeDefined()
      const summary = JSON.parse(writes["dispatch-summary.json"]!)
      expect(summary.finalVerdict).toBe("accepted")
      expect(summary.baseline.branch).toBe("main")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses to start on a dirty workspace", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "README.md"), "hello\ndirty\n")
      const d = new OpenCodeSessionDispatcher({
        worker: new StubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async () => "/x",
      })
      await expect(d.dispatch(makeInput(dir))).rejects.toThrow(/uncommitted changes/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("retries on no_changes worker and ends up needs_human after retries", async () => {
    const dir = await initRepo()
    try {
      const writes: Record<string, string> = {}
      const d = new OpenCodeSessionDispatcher({
        worker: new StubWorker({ failMode: "no_changes" }),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async (n, c) => { writes[n] = c; return `/w/${n}` },
      })
      const r = await d.dispatch(makeInput(dir))
      expect(r.dispatched).toBe(false)
      const summary = JSON.parse(writes["dispatch-summary.json"]!)
      expect(["needs_human"]).toContain(summary.finalVerdict)
      expect(summary.attempts.length).toBeGreaterThan(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("dry-run refuses to spawn", async () => {
    const dir = await initRepo()
    try {
      const d = new OpenCodeSessionDispatcher({
        worker: new StubWorker(),
        reviewer: new RuleBasedContractReviewer(),
        workspaceCwd: dir,
        writeArtifact: async () => "/x",
      })
      const input = { ...makeInput(dir), dryRun: true }
      const r = await d.dispatch(input)
      expect(r.dispatched).toBe(false)
      expect(r.reason).toMatch(/dry-run/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
