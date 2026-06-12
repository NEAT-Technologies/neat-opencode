import { describe, expect, test } from "bun:test"
import { buildRoleContract } from "../src/orchestration/role-contract-builders"
import { normalizeIncident } from "../src/incident/schema"
import type { GraphContext } from "../src/neat/context-builder"

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "n", fetched: true },
    incident: { id: "INC", issueType: "x", severity: "medium", message: "", evidence: [], candidateFiles: [], labels: [] },
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

const incident = normalizeIncident({
  incidentId: "INC-9",
  primaryNodeId: "n",
  issueType: "runtime_exception",
  candidateFiles: ["src/a.ts"],
})

const planObj = {
  incidentId: "INC-9",
  issueClass: "runtime_exception" as const,
  classificationReasons: [],
  affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
  strategy: { name: "x", description: "y", agentTasks: [] },
  validationCommands: [],
  nextAction: "dispatch_to_opencode" as const,
  rationale: "",
}

describe("buildRoleContract", () => {
  test("graph_context: empty allowedFiles, no validation cmds, no patch criterion", () => {
    const c = buildRoleContract({
      role: "graph_context",
      sequence: 0,
      incident,
      graph: fakeGraph(),
      plan: planObj,
      classification: { class: "runtime_exception", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: ["jest"],
      priorFindings: {},
    })
    expect(c.allowedFiles).toEqual([])
    expect(c.validationCommands).toEqual([])
    expect(c.agentRole).toBe("graph_context")
    expect(c.successCriteria.some((s) => /graph signal/i.test(s))).toBe(true)
  })

  test("test role: validation commands present", () => {
    const c = buildRoleContract({
      role: "test",
      sequence: 0,
      incident,
      graph: fakeGraph(),
      plan: planObj,
      classification: { class: "runtime_exception", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: ["jest", "lint"],
      priorFindings: {},
    })
    expect(c.validationCommands).toEqual(["jest", "lint"])
    expect(c.allowedFiles).toEqual([])
  })

  test("patch role: keeps base contract's allowedFiles and successCriteria; references priorFindings", () => {
    const c = buildRoleContract({
      role: "patch",
      sequence: 0,
      incident,
      graph: fakeGraph(),
      plan: planObj,
      classification: { class: "runtime_exception", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: [],
      priorFindings: {
        root_cause: {
          contractId: "x",
          status: "completed",
          summary: "null deref in handler",
          filesChanged: [],
          testsRun: [],
          riskNotes: [],
          unresolvedQuestions: [],
        },
      },
    })
    expect(c.allowedFiles).toContain("src/a.ts")
    expect(c.objective).toContain("priorFindings.root_cause.summary")
    expect(c.successCriteria.length).toBeGreaterThan(0)
  })

  test("migration role: writes to migrations/, removes migrations from forbidden", () => {
    const c = buildRoleContract({
      role: "migration",
      sequence: 0,
      incident: normalizeIncident({
        incidentId: "INC-DB",
        primaryNodeId: "n",
        candidateFiles: ["migrations/0001.sql", "src/db.ts"],
      }),
      graph: fakeGraph(),
      plan: { ...planObj, issueClass: "db_schema_or_query" },
      classification: { class: "db_schema_or_query", reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: [],
      priorFindings: {},
    })
    expect(c.allowedFiles.some((f) => f.startsWith("migrations/"))).toBe(true)
    expect(c.forbiddenFiles.some((f) => /migrations/i.test(f))).toBe(false)
  })
})
