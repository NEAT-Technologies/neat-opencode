import { describe, expect, test } from "bun:test"
import { classifyIncident } from "../src/planner/classifier"
import type { GraphContext } from "../src/neat/context-builder"
import { normalizeIncident } from "../src/incident/schema"

function emptyGraph(): GraphContext {
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
      policyViolations: { status: "unavailable", endpoint: "u", error: "n/a" },
    },
    unavailable: [],
  }
}

describe("classifyIncident", () => {
  test("explicit issueType wins", () => {
    const c = classifyIncident(
      normalizeIncident({ incidentId: "1", primaryNodeId: "n", issueType: "runtime_exception" }),
      emptyGraph(),
    )
    expect(c.class).toBe("runtime_exception")
    expect(c.confidence).toBe("high")
  })

  test("policy_violation comes from NEAT context", () => {
    const g = emptyGraph()
    g.sections.policyViolations = {
      status: "ok",
      endpoint: "http://x/policies/violations",
      data: { violations: [{ policyId: "p", onViolation: "block" }] },
    }
    const c = classifyIncident(normalizeIncident({ incidentId: "1", primaryNodeId: "n" }), g)
    expect(c.class).toBe("policy_violation")
  })

  test("stale_edge from failingEdge.type", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "n",
        failingEdge: { type: "stale" },
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("stale_edge")
  })

  test("divergence from NEAT divergences", () => {
    const g = emptyGraph()
    g.sections.divergences = {
      status: "ok",
      endpoint: "http://x/graph/divergences",
      data: { divergences: [{ type: "x", confidence: 0.9 }] },
    }
    const c = classifyIncident(normalizeIncident({ incidentId: "1", primaryNodeId: "n" }), g)
    expect(c.class).toBe("divergence")
  })

  test("db_schema_or_query from migrations path", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "n",
        candidateFiles: ["db/migrations/2026_06_foo.sql"],
        message: "syntax error in alter table",
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("db_schema_or_query")
  })

  test("http_5xx from message", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "endpoint:/checkout",
        message: "Service responded 502 Bad Gateway",
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("http_5xx")
  })

  test("runtime_exception from stack", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "n",
        evidence: [{ stack: "TypeError: x\n  at file:1" }],
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("runtime_exception")
  })

  test("dependency_failure from message", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "n",
        message: "ECONNREFUSED to upstream service",
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("dependency_failure")
  })

  test("missing_instrumentation from label", () => {
    const c = classifyIncident(
      normalizeIncident({
        incidentId: "1",
        primaryNodeId: "n",
        labels: ["uninstrumented"],
      }),
      emptyGraph(),
    )
    expect(c.class).toBe("missing_instrumentation")
  })

  test("unknown when nothing matches", () => {
    const c = classifyIncident(normalizeIncident({ incidentId: "1", primaryNodeId: "n", message: "..." }), emptyGraph())
    expect(c.class).toBe("unknown")
    expect(c.confidence).toBe("low")
  })
})
