import { describe, expect, test } from "bun:test"
import { buildOrchestrationPlan } from "../src/orchestration/plan"
import type { Classification, IssueClass } from "../src/planner/classifier"

function cls(c: IssueClass): Classification {
  return { class: c, reasons: [], confidence: "high" }
}

describe("buildOrchestrationPlan", () => {
  test("runtime_exception → standard code-fix sequence", () => {
    const p = buildOrchestrationPlan(cls("runtime_exception"))
    const roles = p.steps.map((s) => s.role)
    expect(roles).toEqual(["graph_context", "root_cause", "patch", "test", "security_risk", "reviewer"])
  })

  test("db_schema_or_query → migration role replaces patch", () => {
    const p = buildOrchestrationPlan(cls("db_schema_or_query"))
    const roles = p.steps.map((s) => s.role)
    expect(roles).toContain("migration")
    expect(roles).not.toContain("patch")
    expect(roles[roles.length - 1]).toBe("reviewer")
  })

  test("policy_violation → security_risk runs before test", () => {
    const p = buildOrchestrationPlan(cls("policy_violation"))
    const roles = p.steps.map((s) => s.role)
    const securityIdx = roles.indexOf("security_risk")
    const testIdx = roles.indexOf("test")
    expect(securityIdx).toBeGreaterThan(-1)
    expect(testIdx).toBeGreaterThan(securityIdx)
  })

  test("unknown → investigate only, no patch", () => {
    const p = buildOrchestrationPlan(cls("unknown"))
    const roles = p.steps.map((s) => s.role)
    expect(roles).toEqual(["graph_context", "root_cause", "reviewer"])
  })

  test("dependsOn is populated for downstream roles", () => {
    const p = buildOrchestrationPlan(cls("runtime_exception"))
    const patch = p.steps.find((s) => s.role === "patch")
    expect(patch?.dependsOn).toContain("root_cause")
  })
})
