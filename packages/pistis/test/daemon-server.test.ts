import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PistisDaemon } from "../src/daemon/server"
import { RunRegistry } from "../src/daemon/run-registry"
import type { RunPistisResult } from "../src/index"

const TOKEN = "test-token-do-not-use-in-production"

async function stubRunImpl(opts: { incidentPath: string }): Promise<RunPistisResult> {
  const incident = JSON.parse(await fs.readFile(opts.incidentPath, "utf8"))
  const runDir = await fs.mkdtemp(join(tmpdir(), "pistis-daemon-test-"))
  await fs.writeFile(join(runDir, "final-report.md"), `# Run for ${incident.incidentId}\n`, "utf8")
  await fs.writeFile(join(runDir, "patch.diff"), "diff --git a/x b/x\n", "utf8")
  return {
    incidentId: String(incident.incidentId ?? incident.id ?? "unknown"),
    runDir,
    artifacts: ["final-report.md", "patch.diff"],
    classification: "runtime_exception",
    worstRiskStatus: "pass",
    policyStatus: "pass",
    dispatched: true,
    dryRun: false,
    dispatchReason: "stub",
  }
}

function startDaemon(extra: Partial<ConstructorParameters<typeof PistisDaemon>[0]> = {}): {
  daemon: PistisDaemon
  url: string
  registry: RunRegistry
} {
  const registry = extra.runRegistry ?? new RunRegistry()
  const daemon = new PistisDaemon({
    port: 0,
    hostname: "127.0.0.1",
    token: TOKEN,
    runImpl: stubRunImpl,
    runRegistry: registry,
    ...extra,
  })
  const info = daemon.start()
  return { daemon, url: info.url, registry }
}

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...headers }
}

async function readJson(res: Response): Promise<any> {
  return res.json() as Promise<any>
}

async function waitForRunStatus(
  daemonUrl: string,
  runId: string,
  predicate: (status: string) => boolean,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${daemonUrl}/runs/${encodeURIComponent(runId)}`, { headers: authed() })
    if (res.ok) {
      const body = await readJson(res)
      if (predicate(body.status)) return body
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`run ${runId} did not reach desired status within ${timeoutMs}ms`)
}

describe("PistisDaemon (e2e against Bun.serve)", () => {
  let ctx: ReturnType<typeof startDaemon>

  beforeEach(() => {
    ctx = startDaemon()
  })
  afterEach(async () => {
    await ctx.daemon.stop()
  })

  test("constructor throws on empty token", () => {
    expect(() => new PistisDaemon({ port: 0, token: "" })).toThrow(/token is required/i)
  })

  test("constructor throws on webhook without secret", () => {
    expect(() => new PistisDaemon({
      port: 0,
      token: TOKEN,
      webhook: { url: "http://x", secret: "" },
    })).toThrow(/webhook\.secret is required/i)
  })

  test("Test 19: /health returns ONLY ok+version+uptimeSeconds (no feature leak)", async () => {
    const res = await fetch(`${ctx.url}/health`)
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(Object.keys(body).sort()).toEqual(["ok", "uptimeSeconds", "version"])
    expect(body.ok).toBe(true)
  })

  test("/health does not require auth", async () => {
    const res = await fetch(`${ctx.url}/health`)
    expect(res.status).toBe(200)
  })

  test("Test 7: unauthenticated request → 401, no body details", async () => {
    const res = await fetch(`${ctx.url}/runs`)
    expect(res.status).toBe(401)
    const body = await readJson(res)
    expect(body.error).toBe("unauthorized")
  })

  test("Test 8: wrong Bearer → 401", async () => {
    const res = await fetch(`${ctx.url}/runs`, {
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  test("Test 20: /capabilities requires auth and returns features", async () => {
    await ctx.daemon.stop()
    ctx = startDaemon({
      defaultConfig: { useRouter: true, useKimiReviewer: false, multiAgent: true },
    })
    const unauth = await fetch(`${ctx.url}/capabilities`)
    expect(unauth.status).toBe(401)
    const auth = await fetch(`${ctx.url}/capabilities`, { headers: authed() })
    expect(auth.status).toBe(200)
    const body = await readJson(auth)
    expect(body.features.router).toBe(true)
    expect(body.features.kimiReviewer).toBe(false)
  })

  test("Test 1, 3: POST /run queues a run, GET /runs/:id transitions to completed", async () => {
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        incident: { incidentId: "INC-A", primaryNodeId: "svc:x", issueType: "runtime_exception" },
      }),
    })
    expect(res.status).toBe(202)
    const queued = await readJson(res)
    expect(queued.runId).toBeDefined()
    expect(queued.status).toBe("queued")

    const finished = await waitForRunStatus(ctx.url, queued.runId, (s) => s === "completed")
    expect(finished.classification).toBe("runtime_exception")
    expect(finished.verdict).toBe("accepted")
    expect(finished.artifacts).toContain("final-report.md")
  })

  test("Test 2: POST /run with missing incident → 400", async () => {
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ config: {} }),
    })
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.error).toMatch(/missing incident/)
  })

  test("Test 25: POST /run with body > maxRunBodyBytes → 413", async () => {
    await ctx.daemon.stop()
    ctx = startDaemon({ maxRunBodyBytes: 100 })
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ incident: { incidentId: "X", primaryNodeId: "y", padding: "z".repeat(500) } }),
    })
    expect(res.status).toBe(413)
  })

  test("Test 26: POST /run with wrong Content-Type → 415", async () => {
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "text/plain" }),
      body: "{}",
    })
    expect(res.status).toBe(415)
  })

  test("POST /run with malformed JSON → 400", async () => {
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: "{not json",
    })
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.error).toMatch(/invalid JSON body/)
  })

  test("Test 23: workspace that doesn't exist → 400, no run created", async () => {
    const res = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        incident: { incidentId: "X", primaryNodeId: "y" },
        config: { workspace: "/nonexistent/path/that/should/not/exist/anywhere" },
      }),
    })
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.error).toMatch(/workspace/i)
    const listRes = await fetch(`${ctx.url}/runs`, { headers: authed() })
    const list = await readJson(listRes)
    expect(list.runs.length).toBe(0)
  })

  test("Test 5: GET /runs/:id/artifacts/:name serves the file", async () => {
    const r1 = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ incident: { incidentId: "INC-B", primaryNodeId: "svc:x" } }),
    })
    const { runId } = await readJson(r1)
    await waitForRunStatus(ctx.url, runId, (s) => s === "completed")

    const art = await fetch(`${ctx.url}/runs/${encodeURIComponent(runId)}/artifacts/final-report.md`, {
      headers: authed(),
    })
    expect(art.status).toBe(200)
    expect(art.headers.get("content-type")).toContain("text/markdown")
    const text = await art.text()
    expect(text).toContain("# Run for INC-B")
  })

  test("Test 21: artifact path traversal → 400", async () => {
    const r1 = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ incident: { incidentId: "INC-C", primaryNodeId: "svc:x" } }),
    })
    const { runId } = await readJson(r1)
    await waitForRunStatus(ctx.url, runId, (s) => s === "completed")

    const art = await fetch(`${ctx.url}/runs/${encodeURIComponent(runId)}/artifacts/..%2F..%2Fetc%2Fpasswd`, {
      headers: authed(),
    })
    expect(art.status).toBe(400)
  })

  test("Test 4: GET /runs returns the list", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${ctx.url}/run`, {
        method: "POST",
        headers: authed({ "Content-Type": "application/json" }),
        body: JSON.stringify({ incident: { incidentId: `INC-LIST-${i}`, primaryNodeId: "svc:x" } }),
      })
      await readJson(r)
    }
    const res = await fetch(`${ctx.url}/runs`, { headers: authed() })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.runs.length).toBeGreaterThanOrEqual(3)
  })

  test("Test 6: POST /runs/:id/cancel returns cancelling", async () => {
    // Use a slow stub run so we can cancel it before completion.
    await ctx.daemon.stop()
    ctx = startDaemon({
      runImpl: async (opts) => {
        await new Promise((r) => setTimeout(r, 200))
        return stubRunImpl(opts)
      },
    })
    const r1 = await fetch(`${ctx.url}/run`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ incident: { incidentId: "INC-CANCEL", primaryNodeId: "svc:x" } }),
    })
    const { runId } = await readJson(r1)
    const cancel = await fetch(`${ctx.url}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: "{}",
    })
    expect(cancel.status).toBe(200)
    const body = await readJson(cancel)
    expect(body.status).toBe("cancelling")
  })

  test("POST /runs/:id/cancel for unknown run → 404", async () => {
    const res = await fetch(`${ctx.url}/runs/nope/cancel`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: "{}",
    })
    expect(res.status).toBe(404)
  })

  test("Test 17: GET /schema/incident returns the JSON Schema", async () => {
    const res = await fetch(`${ctx.url}/schema/incident`, { headers: authed() })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("schema+json")
    const body = await readJson(res)
    expect(body.$schema).toContain("json-schema.org")
    expect(body.title).toBe("Pistis Incident")
  })

  test("Test 27: no CORS by default; OPTIONS returns 405", async () => {
    const res = await fetch(`${ctx.url}/runs`, { method: "OPTIONS" })
    expect(res.status).toBe(405)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("Test 27 (variant): with --cors-origin, OPTIONS returns 200 with CORS headers", async () => {
    await ctx.daemon.stop()
    ctx = startDaemon({ corsOrigin: "https://neat.local" })
    const opt = await fetch(`${ctx.url}/runs`, { method: "OPTIONS" })
    expect(opt.status).toBe(200)
    expect(opt.headers.get("access-control-allow-origin")).toBe("https://neat.local")

    const get = await fetch(`${ctx.url}/runs`, { headers: authed() })
    expect(get.headers.get("access-control-allow-origin")).toBe("https://neat.local")
  })
})
