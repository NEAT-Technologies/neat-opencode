import { describe, expect, test } from "bun:test"
import { NeatClient } from "../src/neat/client"
import { buildGraphContext } from "../src/neat/context-builder"
import { normalizeIncident } from "../src/incident/schema"

interface RouteHandler {
  match: (pathname: string) => boolean
  respond: () => Response | Promise<Response>
}

function fakeNeat(routes: RouteHandler[], fallback?: () => Response): typeof fetch {
  return ((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const u = new URL(url)
    for (const r of routes) {
      if (r.match(u.pathname)) return Promise.resolve(r.respond())
    }
    return Promise.resolve(fallback ? fallback() : new Response("not found", { status: 404 }))
  }) as typeof fetch
}

const incident = normalizeIncident({
  incidentId: "INC-1",
  primaryNodeId: "service:foo",
  message: "boom",
})

describe("buildGraphContext", () => {
  test("collects ok sections + records unavailable ones", async () => {
    const fetchImpl = fakeNeat([
      { match: (p) => p === "/health", respond: () => new Response('{"ok":true}', { status: 200 }) },
      {
        match: (p) => p === "/graph/node/service%3Afoo",
        respond: () => new Response('{"node":{"id":"service:foo"}}', { status: 200 }),
      },
      {
        match: (p) => p === "/graph/edges/service%3Afoo",
        respond: () => new Response('{"inbound":[],"outbound":[]}', { status: 200 }),
      },
      {
        match: (p) => p === "/graph/blast-radius/service%3Afoo",
        respond: () => new Response('{"affectedNodes":["a","b","c"]}', { status: 200 }),
      },
      {
        match: (p) => p === "/incidents/service%3Afoo",
        respond: () => new Response('{"count":0,"total":0,"events":[]}', { status: 200 }),
      },
      {
        match: (p) => p === "/policies/violations",
        respond: () => new Response('{"violations":[]}', { status: 200 }),
      },
    ])
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    const ctx = await buildGraphContext(c, incident)
    expect(ctx.neat.healthOk).toBe(true)
    expect(ctx.primaryNode.fetched).toBe(true)
    expect(ctx.sections.edges.status).toBe("ok")
    expect(ctx.sections.blastRadius.status).toBe("ok")
    expect(ctx.sections.rootCause.status).toBe("unavailable")
    expect(ctx.sections.dependencies.status).toBe("unavailable")
    expect(ctx.unavailable.length).toBeGreaterThan(0)
  })

  test("throws when /health is unavailable", async () => {
    const fetchImpl = fakeNeat([], () => new Response("down", { status: 503 }))
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    await expect(buildGraphContext(c, incident)).rejects.toThrow(/health/)
  })

  test("throws when primary node lookup fails", async () => {
    const fetchImpl = fakeNeat([
      { match: (p) => p === "/health", respond: () => new Response("{}", { status: 200 }) },
      { match: (p) => p.startsWith("/graph/node/"), respond: () => new Response('{"error":"missing"}', { status: 404 }) },
    ])
    const c = new NeatClient({ baseUrl: "http://x", fetchImpl })
    await expect(buildGraphContext(c, incident)).rejects.toThrow(/primary node/)
  })
})
