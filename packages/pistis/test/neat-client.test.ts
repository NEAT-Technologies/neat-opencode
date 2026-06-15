import { describe, expect, test } from "bun:test"
import { NeatClient, NeatHttpError, resolveNeatBaseUrl, redactToken } from "../src/neat/client"

function makeFakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const req = new Request(url, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

describe("NeatClient URL construction", () => {
  test("builds default-project URL when no project is set", () => {
    const c = new NeatClient({ baseUrl: "http://localhost:8080" })
    expect(c.buildUrl("/graph/node/foo")).toBe("http://localhost:8080/graph/node/foo")
    expect(c.buildRootUrl("/health")).toBe("http://localhost:8080/health")
  })

  test("project-scoped URL is /projects/:project/...", () => {
    const c = new NeatClient({ baseUrl: "http://localhost:8080/", project: "demo" })
    expect(c.buildUrl("/graph/node/n1")).toBe("http://localhost:8080/projects/demo/graph/node/n1")
  })

  test("project name is URL-encoded", () => {
    const c = new NeatClient({ baseUrl: "http://x", project: "team a" })
    // buildUrl does not encode the suffix (callers do — see getNode); it only
    // encodes the project segment.
    expect(c.buildUrl("/graph/node/n1")).toBe("http://x/projects/team%20a/graph/node/n1")
  })

  test("query parameters are appended", () => {
    const c = new NeatClient({ baseUrl: "http://x" })
    expect(c.buildUrl("/graph/blast-radius/n", { depth: 3 })).toBe("http://x/graph/blast-radius/n?depth=3")
  })
})

describe("NeatClient auth + project routing", () => {
  test("sets Authorization header when authToken is provided", async () => {
    const seen: Array<string | null> = []
    const fetchImpl = makeFakeFetch((req) => {
      seen.push(req.headers.get("authorization"))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    })
    const c = new NeatClient({ baseUrl: "http://x", authToken: "tok-123", fetchImpl })
    await c.health()
    expect(seen[0]).toBe("Bearer tok-123")
  })

  test("omits Authorization header when no token", async () => {
    const seen: Array<string | null> = []
    const fetchImpl = makeFakeFetch((req) => {
      seen.push(req.headers.get("authorization"))
      return new Response("{}", { status: 200 })
    })
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    await c.health()
    expect(seen[0]).toBeNull()
  })

  test("getNode hits the project-scoped path when project is set", async () => {
    const hits: string[] = []
    const fetchImpl = makeFakeFetch((req) => {
      hits.push(req.url)
      return new Response(JSON.stringify({ node: { id: "n" } }), { status: 200 })
    })
    const c = new NeatClient({ baseUrl: "http://x", project: "demo", fetchImpl })
    await c.getNode("svc:foo")
    expect(hits[0]).toBe("http://x/projects/demo/graph/node/svc%3Afoo")
  })
})

describe("NeatClient soft-failing optional endpoints", () => {
  test("getEdges returns ok=false on 404", async () => {
    const fetchImpl = makeFakeFetch(() => new Response(JSON.stringify({ error: "node not found" }), { status: 404 }))
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    const r = await c.getEdges("missing")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(404)
      expect(r.error).toContain("node not found")
    }
  })

  test("getEdges returns ok=true with data on 200", async () => {
    const fetchImpl = makeFakeFetch(() => new Response(JSON.stringify({ inbound: [], outbound: [] }), { status: 200 }))
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    const r = await c.getEdges("ok")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ inbound: [], outbound: [] })
  })

  test("getNode throws NeatHttpError on non-2xx", async () => {
    const fetchImpl = makeFakeFetch(() => new Response("nope", { status: 500 }))
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    await expect(c.getNode("x")).rejects.toBeInstanceOf(NeatHttpError)
  })

  test("checkPolicies POSTs JSON body", async () => {
    const captured: { body?: string; method?: string } = {}
    const fetchImpl = makeFakeFetch(async (req) => {
      captured.method = req.method
      captured.body = await req.text()
      return new Response(JSON.stringify({ allowed: true, violations: [] }), { status: 200 })
    })
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    const r = await c.checkPolicies()
    expect(captured.method).toBe("POST")
    expect(captured.body).toBe(JSON.stringify({ hypotheticalAction: undefined }))
    expect(r.ok).toBe(true)
  })
})

describe("env helpers", () => {
  test("resolveNeatBaseUrl prefers explicit", () => {
    expect(resolveNeatBaseUrl("http://a/")).toBe("http://a")
  })

  test("resolveNeatBaseUrl falls back to default", () => {
    delete process.env.NEAT_CORE_URL
    expect(resolveNeatBaseUrl()).toBe("http://localhost:8080")
  })

  test("redactToken never returns raw token", () => {
    const out = redactToken("supersecretX")
    expect(out).not.toContain("supersecret")
    expect(out).toMatch(/^<set:\*\*\*\*/)
  })

  test("redactToken handles undefined", () => {
    expect(redactToken(undefined)).toBe("<none>")
  })
})
