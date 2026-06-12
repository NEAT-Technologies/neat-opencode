import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { runPistis } from "../src/index"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"

/**
 * End-to-end Phase 1 dry run using a fake NEAT Fastify-shaped responder.
 * We spin up Bun.serve to mimic NEAT closely enough to exercise the full
 * pipeline: incident load → context fetch → classify → plan → risk/policy
 * gates → noop dispatch → final report.
 */

function startFakeNeat(): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url)
      const p = u.pathname
      // Both default and project-scoped routes use the same handlers; strip
      // the project prefix here since this test only uses the root mount.
      const stripped = p.replace(/^\/projects\/[^/]+/, "")
      if (p === "/health" || stripped === "/health") {
        return Response.json({ ok: true, uptimeMs: 1, projects: [] })
      }
      if (stripped.startsWith("/graph/node/")) {
        const id = decodeURIComponent(stripped.slice("/graph/node/".length))
        return Response.json({ node: { id, kind: "service" } })
      }
      if (stripped.startsWith("/graph/edges/")) {
        return Response.json({ inbound: [], outbound: [] })
      }
      if (stripped.startsWith("/graph/root-cause/")) {
        return Response.json({ rootCause: "candidate", confidence: 0.7 })
      }
      if (stripped.startsWith("/graph/blast-radius/")) {
        return Response.json({ affectedNodes: ["a", "b"] })
      }
      if (stripped.startsWith("/graph/dependencies/")) {
        return Response.json({ dependencies: [] })
      }
      if (stripped === "/graph/divergences") {
        return Response.json({ divergences: [] })
      }
      if (stripped === "/incidents" || stripped.startsWith("/incidents/")) {
        return Response.json({ count: 0, total: 0, events: [] })
      }
      if (stripped === "/policies/violations") {
        return Response.json({ violations: [] })
      }
      if (stripped === "/policies/check") {
        return Response.json({ allowed: true, violations: [] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: async () => {
      server.stop(true)
    },
  }
}

describe("runPistis (end-to-end)", () => {
  let fake: { url: string; stop: () => Promise<void> }
  let outDir: string
  let incidentPath: string

  beforeAll(async () => {
    fake = startFakeNeat()
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pistis-e2e-"))
    incidentPath = path.join(outDir, "incident.json")
    await fs.writeFile(
      incidentPath,
      JSON.stringify({
        incidentId: "INC-E2E-1",
        issueType: "runtime_exception",
        severity: "medium",
        primaryNodeId: "service:checkout",
        message: "TypeError",
        candidateFiles: ["packages/checkout/src/handlers/checkout.ts"],
        evidence: [{ stack: "TypeError: x\n  at handler" }],
      }),
    )
  })

  afterAll(async () => {
    await fake.stop()
    await fs.rm(outDir, { recursive: true, force: true })
  })

  test("dry-run writes every required artifact", async () => {
    const result = await runPistis({
      incidentPath,
      neatUrl: fake.url,
      outDir: path.join(outDir, "runs"),
      testCommands: ["npm test"],
      dryRun: true,
    })
    expect(result.incidentId).toBe("INC-E2E-1")
    expect(result.classification).toBe("runtime_exception")
    expect(result.dispatched).toBe(false)
    expect(result.dryRun).toBe(true)
    const required = [
      "incident.json",
      "graph-context.json",
      "plan.md",
      "validation.json",
      "dispatch-request.json",
      "final-report.md",
    ]
    for (const f of required) expect(result.artifacts).toContain(f)
    const report = await fs.readFile(path.join(result.runDir, "final-report.md"), "utf8")
    expect(report).toContain("# Pistis Final Report — INC-E2E-1")
    expect(report).toContain("**No code was modified.**")
    const dispatchReq = JSON.parse(await fs.readFile(path.join(result.runDir, "dispatch-request.json"), "utf8"))
    expect(dispatchReq.dispatcher).toBe("noop")
    expect(dispatchReq.contract.contractId).toMatch(/^INC-E2E-1::patch::000$/)
    expect(dispatchReq.contract.allowedFiles).toContain("packages/checkout/src/handlers/checkout.ts")
  })

  test("--apply without --workspace is rejected (no blocking gates)", async () => {
    // Use a fresh incident with a neutral path so no risk gate blocks.
    const neutralIncidentPath = path.join(outDir, "incident-neutral.json")
    await fs.writeFile(
      neutralIncidentPath,
      JSON.stringify({
        incidentId: "INC-NEUTRAL-1",
        issueType: "runtime_exception",
        severity: "low",
        primaryNodeId: "service:plain",
        message: "x",
        candidateFiles: ["src/app.ts"],
      }),
    )
    await expect(
      runPistis({
        incidentPath: neutralIncidentPath,
        neatUrl: fake.url,
        outDir: path.join(outDir, "runs2"),
        apply: true,
      }),
    ).rejects.toThrow(/--workspace/)
  })

  test("--pr is rejected in Phase 1", async () => {
    await expect(
      runPistis({
        incidentPath,
        neatUrl: fake.url,
        outDir: path.join(outDir, "runs3"),
        pr: true,
      }),
    ).rejects.toThrow(/pr/i)
  })

  test("--apply with workspace runs Phase 2 contract loop end-to-end", async () => {
    // Init a fresh git repo as the workspace.
    const wsDir = await fs.mkdtemp(path.join(os.tmpdir(), "pistis-apply-ws-"))
    const { spawn } = await import("node:child_process")
    const sh = (cmd: string, args: string[], cwd: string) =>
      new Promise<number>((res) => {
        const c = spawn(cmd, args, { cwd, stdio: "ignore" })
        c.on("close", (code) => res(code ?? -1))
        c.on("error", () => res(-1))
      })
    await sh("git", ["init", "-q", "-b", "main"], wsDir)
    await sh("git", ["config", "user.email", "p@p"], wsDir)
    await sh("git", ["config", "user.name", "p"], wsDir)
    await fs.mkdir(path.join(wsDir, "src"), { recursive: true })
    await fs.writeFile(path.join(wsDir, "src/app.ts"), "// original\n")
    await sh("git", ["add", "."], wsDir)
    await sh("git", ["commit", "-q", "-m", "init"], wsDir)

    const applyIncidentPath = path.join(outDir, "incident-apply.json")
    await fs.writeFile(
      applyIncidentPath,
      JSON.stringify({
        incidentId: "INC-APPLY-1",
        issueType: "runtime_exception",
        severity: "low",
        primaryNodeId: "service:plain",
        message: "x",
        candidateFiles: ["src/app.ts"],
      }),
    )
    try {
      const result = await runPistis({
        incidentPath: applyIncidentPath,
        neatUrl: fake.url,
        outDir: path.join(outDir, "runs-apply"),
        apply: true,
        workspace: wsDir,
        worker: "stub",
      })
      expect(result.dispatched).toBe(true)
      expect(result.dryRun).toBe(false)
      expect(result.dispatchReason).toContain("accepted")
      for (const f of [
        "incident.json",
        "graph-context.json",
        "plan.md",
        "validation.json",
        "contract-001.json",
        "agent-result-001.json",
        "contract-review-001.json",
        "patch.diff",
        "dispatch-summary.json",
        "final-report.md",
      ]) expect(result.artifacts).toContain(f)
      const review = JSON.parse(await fs.readFile(path.join(result.runDir, "contract-review-001.json"), "utf8"))
      expect(review.verdict).toBe("accepted")
      const diff = await fs.readFile(path.join(result.runDir, "patch.diff"), "utf8")
      expect(diff).toContain("--- a/src/app.ts")
      expect(diff).toContain("PISTIS_NOTE")
    } finally {
      await fs.rm(wsDir, { recursive: true, force: true })
    }
  })

  test("--apply --multi-agent runs the full Phase 3 orchestration", async () => {
    const wsDir = await fs.mkdtemp(path.join(os.tmpdir(), "pistis-multi-ws-"))
    const { spawn } = await import("node:child_process")
    const sh = (cmd: string, args: string[], cwd: string) =>
      new Promise<number>((res) => {
        const c = spawn(cmd, args, { cwd, stdio: "ignore" })
        c.on("close", (code) => res(code ?? -1))
        c.on("error", () => res(-1))
      })
    await sh("git", ["init", "-q", "-b", "main"], wsDir)
    await sh("git", ["config", "user.email", "p@p"], wsDir)
    await sh("git", ["config", "user.name", "p"], wsDir)
    await fs.mkdir(path.join(wsDir, "src"), { recursive: true })
    await fs.writeFile(path.join(wsDir, "src/app.ts"), "// original\n")
    await sh("git", ["add", "."], wsDir)
    await sh("git", ["commit", "-q", "-m", "init"], wsDir)

    const multiIncidentPath = path.join(outDir, "incident-multi.json")
    await fs.writeFile(
      multiIncidentPath,
      JSON.stringify({
        incidentId: "INC-MULTI-1",
        issueType: "runtime_exception",
        severity: "low",
        primaryNodeId: "service:plain",
        message: "x",
        candidateFiles: ["src/app.ts"],
      }),
    )
    try {
      const result = await runPistis({
        incidentPath: multiIncidentPath,
        neatUrl: fake.url,
        outDir: path.join(outDir, "runs-multi"),
        apply: true,
        workspace: wsDir,
        worker: "multi-role-stub",
        multiAgent: true,
      })
      expect(result.dispatched).toBe(true)
      expect(result.dispatchReason).toContain("multi-agent")
      expect(result.artifacts).toContain("orchestration-summary.json")
      // top-level patch.diff exists
      expect(result.artifacts).toContain("patch.diff")
      const orchSummaryRaw = await fs.readFile(path.join(result.runDir, "orchestration-summary.json"), "utf8")
      const orchSummary = JSON.parse(orchSummaryRaw)
      expect(orchSummary.finalVerdict).toBe("accepted")
      expect(Object.keys(orchSummary.roleResults)).toContain("graph_context")
      expect(Object.keys(orchSummary.roleResults)).toContain("patch")
      expect(Object.keys(orchSummary.roleResults)).toContain("reviewer")
    } finally {
      await fs.rm(wsDir, { recursive: true, force: true })
    }
  })

  test("dead NEAT (/health) surfaces a clear error", async () => {
    await expect(
      runPistis({
        incidentPath,
        neatUrl: "http://127.0.0.1:1",
        outDir: path.join(outDir, "runs4"),
      }),
    ).rejects.toThrow(/health/)
    // But the partial incident.json should still exist from the early write.
    // (Walk the runs4 dir to confirm.)
    const runs = await fs.readdir(path.join(outDir, "runs4")).catch(() => [])
    expect(runs.length).toBeGreaterThan(0)
  })
})
