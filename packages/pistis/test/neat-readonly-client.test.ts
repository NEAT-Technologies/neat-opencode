import { describe, expect, test } from "bun:test"
import { NeatClient } from "../src/neat/client"
import { NeatReadOnlyClient } from "../src/reviewers/neat-readonly-client"

function stubNeatClient(handlers: Record<string, (req: Request) => Response | Promise<Response>>): NeatClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return handler(new Request(url, init as RequestInit))
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return new NeatClient({ baseUrl: "http://stub.invalid", fetchImpl })
}

describe("NeatReadOnlyClient", () => {
  test("getNode returns ToolResult.ok when inner resolves", async () => {
    const inner = stubNeatClient({
      "/graph/node/": () =>
        new Response(JSON.stringify({ node: { id: "svc:x", kind: "service" } }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
    })
    const ro = new NeatReadOnlyClient(inner)
    const out = await ro.getNode("svc:x")
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.data as any).node.id).toBe("svc:x")
    }
  })

  test("getNode returns ToolResult.ok=false on 500 (inner throws)", async () => {
    const inner = stubNeatClient({
      "/graph/node/": () => new Response("boom", { status: 500 }),
    })
    const ro = new NeatReadOnlyClient(inner)
    const out = await ro.getNode("svc:x")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0)
  })

  test("getEdges returns ToolResult.ok=false on 502 (inner returns NeatResult)", async () => {
    const inner = stubNeatClient({
      "/graph/edges/": () => new Response("bad gateway", { status: 502 }),
    })
    const ro = new NeatReadOnlyClient(inner)
    const out = await ro.getEdges("svc:x")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/502/)
  })

  test("getBlastRadius passes depth as a query string", async () => {
    let capturedUrl = ""
    const inner = stubNeatClient({
      "/graph/blast-radius/": (req) => {
        capturedUrl = req.url
        return new Response(JSON.stringify({ affectedNodes: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      },
    })
    const ro = new NeatReadOnlyClient(inner)
    await ro.getBlastRadius("svc:x", 3)
    expect(capturedUrl).toContain("depth=3")
  })

  test("getDivergences passes optional nodeId as query", async () => {
    let capturedUrl = ""
    const inner = stubNeatClient({
      "/graph/divergences": (req) => {
        capturedUrl = req.url
        return new Response(JSON.stringify({ divergences: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      },
    })
    const ro = new NeatReadOnlyClient(inner)
    await ro.getDivergences("svc:y")
    expect(capturedUrl).toContain("node=svc%3Ay")
  })

  test("listIncidents passes limit as query", async () => {
    let capturedUrl = ""
    const inner = stubNeatClient({
      "/incidents": (req) => {
        capturedUrl = req.url
        return new Response(JSON.stringify({ events: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      },
    })
    const ro = new NeatReadOnlyClient(inner)
    await ro.listIncidents(5)
    expect(capturedUrl).toContain("limit=5")
  })

  test("getPolicyViolations propagates severity + policyId", async () => {
    let capturedUrl = ""
    const inner = stubNeatClient({
      "/policies/violations": (req) => {
        capturedUrl = req.url
        return new Response(JSON.stringify({ violations: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      },
    })
    const ro = new NeatReadOnlyClient(inner)
    await ro.getPolicyViolations({ severity: "high", policyId: "p1" })
    expect(capturedUrl).toContain("severity=high")
    expect(capturedUrl).toContain("policyId=p1")
  })

  test("no write methods exposed on the wrapper", () => {
    const inner = new NeatClient({ baseUrl: "http://stub.invalid" })
    const ro = new NeatReadOnlyClient(inner)
    const proto = Object.getPrototypeOf(ro)
    const names = new Set<string>(Object.getOwnPropertyNames(proto))
    // none of the write-ish names are present
    for (const banned of ["request", "safe", "checkPolicies", "post", "put", "delete"]) {
      expect(names.has(banned)).toBe(false)
    }
    // the 8 read methods ARE present
    for (const allowed of [
      "getNode", "getEdges", "getBlastRadius", "getDependencies", "getRootCause",
      "getDivergences", "listIncidents", "getPolicyViolations",
    ]) {
      expect(names.has(allowed)).toBe(true)
    }
  })

  test("never throws — network error surfaces as ToolResult.ok=false", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND")
    }) as unknown as typeof fetch
    const inner = new NeatClient({ baseUrl: "http://stub.invalid", fetchImpl })
    const ro = new NeatReadOnlyClient(inner)
    const out = await ro.getEdges("svc:x")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/ENOTFOUND|failed/)
  })
})
