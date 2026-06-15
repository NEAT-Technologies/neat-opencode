import { describe, expect, test } from "bun:test"
import { buildAgentContract } from "../src/contract/builder"
import { normalizeIncident } from "../src/incident/schema"
import type { GraphContext } from "../src/neat/context-builder"

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "n", fetched: true },
    incident: {
      id: "INC", issueType: "runtime_exception", severity: "high", message: "",
      evidence: [], candidateFiles: [], labels: [],
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

describe("buildAgentContract", () => {
  test("produces stable contractId and core fields", () => {
    const c = buildAgentContract({
      incident: normalizeIncident({
        incidentId: "INC-1",
        primaryNodeId: "n",
        issueType: "runtime_exception",
        candidateFiles: ["src/a.ts", "src/b.ts"],
      }),
      graph: fakeGraph(),
      plan: {
        incidentId: "INC-1", issueClass: "runtime_exception", classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
        strategy: { name: "x", description: "y", agentTasks: [] },
        validationCommands: [], nextAction: "dispatch_to_opencode", rationale: "",
      },
      classification: { class: "runtime_exception", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: ["npm test"],
    })
    expect(c.contractId).toBe("INC-1::patch::000")
    expect(c.agentRole).toBe("patch")
    expect(c.allowedFiles).toEqual(["src/a.ts", "src/b.ts"])
    expect(c.successCriteria.length).toBeGreaterThan(0)
    expect(c.validationCommands).toEqual(["npm test"])
    expect(c.maxRetries).toBe(2)
    expect(c.requiredOutputs).toContain("patch.diff")
  })

  test("forbids well-known dangerous paths via the FORBIDDEN_PATTERNS list", () => {
    const c = buildAgentContract({
      incident: normalizeIncident({
        incidentId: "INC-2",
        primaryNodeId: "n",
        candidateFiles: [
          "src/a.ts",
          "migrations/0001_init.sql",
          ".env",
          "src/auth/login.ts",
          "billing/charge.ts",
        ],
      }),
      graph: fakeGraph(),
      plan: {
        incidentId: "INC-2", issueClass: "unknown", classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
        strategy: { name: "x", description: "y", agentTasks: [] },
        validationCommands: [], nextAction: "dispatch_to_opencode", rationale: "",
      },
      classification: { class: "unknown", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: [],
    })
    expect(c.forbiddenFiles).toContain("migrations/0001_init.sql")
    expect(c.forbiddenFiles).toContain(".env")
    expect(c.forbiddenFiles).toContain("src/auth/login.ts")
    expect(c.forbiddenFiles).toContain("billing/charge.ts")
    expect(c.forbiddenFiles).not.toContain("src/a.ts")
  })

  test("adds db-specific constraint for db_schema_or_query", () => {
    const c = buildAgentContract({
      incident: normalizeIncident({ incidentId: "INC-3", primaryNodeId: "n", candidateFiles: ["src/db.ts"] }),
      graph: fakeGraph(),
      plan: {
        incidentId: "INC-3", issueClass: "db_schema_or_query", classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
        strategy: { name: "x", description: "y", agentTasks: [] },
        validationCommands: [], nextAction: "dispatch_to_opencode", rationale: "",
      },
      classification: { class: "db_schema_or_query", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: [],
    })
    expect(c.constraints.some((s) => /migration/i.test(s))).toBe(true)
  })

  test("validation criterion appears when commands provided", () => {
    const c = buildAgentContract({
      incident: normalizeIncident({ incidentId: "INC-4", primaryNodeId: "n" }),
      graph: fakeGraph(),
      plan: {
        incidentId: "INC-4", issueClass: "unknown", classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
        strategy: { name: "x", description: "y", agentTasks: [] },
        validationCommands: [], nextAction: "dispatch_to_opencode", rationale: "",
      },
      classification: { class: "unknown", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: ["jest"],
    })
    expect(c.successCriteria.some((s) => s.includes("validation commands"))).toBe(true)
  })
})
