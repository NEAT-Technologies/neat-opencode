import { describe, expect, test } from "bun:test"
import { runPreflightRiskGates, worstStatus } from "../src/validation/risk-gate"
import type { GraphContext } from "../src/neat/context-builder"
import { normalizeIncident } from "../src/incident/schema"
import { classifyIncident } from "../src/planner/classifier"

function baseGraph(): GraphContext {
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

function gate(results: ReturnType<typeof runPreflightRiskGates>, id: string) {
  return results.find((g) => g.gateId === id)
}

describe("risk gates", () => {
  test("db_migration triggers requires_approval", () => {
    const incident = normalizeIncident({
      incidentId: "1",
      primaryNodeId: "n",
      candidateFiles: ["db/migrations/2026_06_foo.sql"],
      message: "alter table",
    })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "db_migration")?.status).toBe("requires_approval")
  })

  test("auth_change triggers requires_approval", () => {
    const incident = normalizeIncident({
      incidentId: "1",
      primaryNodeId: "n",
      candidateFiles: ["src/auth/login.ts"],
    })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "auth_change")?.status).toBe("requires_approval")
  })

  test("payment_change triggers requires_approval", () => {
    const incident = normalizeIncident({
      incidentId: "1",
      primaryNodeId: "n",
      candidateFiles: ["src/billing/stripe.ts"],
    })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "payment_change")?.status).toBe("requires_approval")
  })

  test("secrets_or_env triggers requires_approval", () => {
    const incident = normalizeIncident({
      incidentId: "1",
      primaryNodeId: "n",
      candidateFiles: [".env.production"],
    })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "secrets_or_env")?.status).toBe("requires_approval")
  })

  test("destructive_change blocks regardless of approval", () => {
    const incident = normalizeIncident({
      incidentId: "1",
      primaryNodeId: "n",
      message: "We will drop table users",
    })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification, approvals: ["destructive_change"] })
    expect(gate(gates, "destructive_change")?.status).toBe("block")
  })

  test("blast_radius requires_approval when over threshold", () => {
    const incident = normalizeIncident({ incidentId: "1", primaryNodeId: "n" })
    const graph = baseGraph()
    graph.sections.blastRadius = {
      status: "ok",
      endpoint: "http://x/graph/blast-radius/n",
      data: { affectedNodes: Array.from({ length: 30 }, (_, i) => `node-${i}`) },
    }
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "blast_radius")?.status).toBe("requires_approval")
  })

  test("blast_radius pass with explicit approval", () => {
    const incident = normalizeIncident({ incidentId: "1", primaryNodeId: "n" })
    const graph = baseGraph()
    graph.sections.blastRadius = {
      status: "ok",
      endpoint: "http://x/graph/blast-radius/n",
      data: { affectedNodes: Array.from({ length: 30 }, (_, i) => `node-${i}`) },
    }
    const classification = classifyIncident(incident, graph)
    const gates = runPreflightRiskGates({ incident, graph, classification, approvals: ["blast_radius"] })
    expect(gate(gates, "blast_radius")?.status).toBe("pass")
  })

  test("unknown + high severity requires_approval", () => {
    const incident = normalizeIncident({ incidentId: "1", primaryNodeId: "n", severity: "high" })
    const graph = baseGraph()
    const classification = classifyIncident(incident, graph) // unknown
    const gates = runPreflightRiskGates({ incident, graph, classification })
    expect(gate(gates, "unknown_high_severity")?.status).toBe("requires_approval")
  })

  test("worstStatus picks block > requires_approval > warn > pass", () => {
    expect(
      worstStatus([
        { gateId: "a", status: "pass", reason: "", evidence: [] },
        { gateId: "b", status: "warn", reason: "", evidence: [] },
        { gateId: "c", status: "requires_approval", reason: "", evidence: [] },
        { gateId: "d", status: "block", reason: "", evidence: [] },
      ]),
    ).toBe("block")
    expect(
      worstStatus([
        { gateId: "a", status: "pass", reason: "", evidence: [] },
        { gateId: "b", status: "warn", reason: "", evidence: [] },
      ]),
    ).toBe("warn")
  })
})
