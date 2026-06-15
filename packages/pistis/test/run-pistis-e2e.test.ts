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
    expect(dispatchReq.incident.id).toBe("INC-E2E-1")
  })

  test("--apply is rejected in Phase 1", async () => {
    await expect(
      runPistis({
        incidentPath,
        neatUrl: fake.url,
        outDir: path.join(outDir, "runs2"),
        apply: true,
      }),
    ).rejects.toThrow(/apply/)
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
