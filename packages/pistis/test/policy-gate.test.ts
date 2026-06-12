import { describe, expect, test } from "bun:test"
import { runPolicyGate } from "../src/validation/policy-gate"
import { NeatClient } from "../src/neat/client"
import type { GraphContext } from "../src/neat/context-builder"

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
}

function graphWith(violations: unknown): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "n", fetched: true },
    incident: {
      id: "INC",
      issueType: "x",
      severity: "medium",
      message: "",
      evidence: [],
      candidateFiles: [],
      labels: [],
    },
    sections: {
      edges: { status: "unavailable", endpoint: "u", error: "n/a" },
      rootCause: { status: "unavailable", endpoint: "u", error: "n/a" },
      blastRadius: { status: "unavailable", endpoint: "u", error: "n/a" },
      dependencies: { status: "unavailable", endpoint: "u", error: "n/a" },
      divergences: { status: "unavailable", endpoint: "u", error: "n/a" },
      incidentsForNode: { status: "unavailable", endpoint: "u", error: "n/a" },
      policyViolations: {
        status: "ok",
        endpoint: "http://x/policies/violations",
        data: { violations },
      },
    },
    unavailable: [],
  }
}

describe("policy gate", () => {
  test("blocks when blocking violation present", async () => {
    const client = new NeatClient({
      baseUrl: "http://x",
      fetchImpl: fakeFetch(() => new Response('{"allowed":true,"violations":[]}', { status: 200 })),
    })
    const r = await runPolicyGate(client, graphWith([{ policyId: "p1", onViolation: "block" }]))
    expect(r.status).toBe("block")
    expect(r.blockingViolations.length).toBe(1)
  })

  test("warns when only non-blocking violations", async () => {
    const client = new NeatClient({
      baseUrl: "http://x",
      fetchImpl: fakeFetch(() => new Response('{"allowed":true,"violations":[]}', { status: 200 })),
    })
    const r = await runPolicyGate(client, graphWith([{ policyId: "p1", onViolation: "warn" }]))
    expect(r.status).toBe("warn")
  })

  test("passes when no violations", async () => {
    const client = new NeatClient({
      baseUrl: "http://x",
      fetchImpl: fakeFetch(() => new Response('{"allowed":true,"violations":[]}', { status: 200 })),
    })
    const r = await runPolicyGate(client, graphWith([]))
    expect(r.status).toBe("pass")
  })

  test("unavailable when both endpoints fail and context section unavailable", async () => {
    const client = new NeatClient({
      baseUrl: "http://x",
      fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })),
    })
    const g = graphWith([])
    g.sections.policyViolations = { status: "unavailable", endpoint: "http://x/policies/violations", error: "500" }
    const r = await runPolicyGate(client, g)
    expect(r.status).toBe("unavailable")
  })

  test("blocks when /policies/check returns allowed=false", async () => {
    const client = new NeatClient({
      baseUrl: "http://x",
      fetchImpl: fakeFetch(() => new Response('{"allowed":false,"violations":[{"policyId":"p","onViolation":"block"}]}', { status: 200 })),
    })
    const r = await runPolicyGate(client, graphWith([]))
    expect(r.status).toBe("block")
  })
})
