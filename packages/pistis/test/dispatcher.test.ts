import { describe, expect, test } from "bun:test"
import { NoopDispatcher, buildSafetyRules } from "../src/opencode/dispatcher"
import type { GateResult } from "../src/validation/risk-gate"
import type { PolicyGateResult } from "../src/validation/policy-gate"
import { normalizeIncident } from "../src/incident/schema"
import type { GraphContext } from "../src/neat/context-builder"

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", healthOk: true },
    primaryNode: { id: "n", fetched: true },
    incident: {
      id: "INC",
      issueType: "runtime_exception",
      severity: "high",
      message: "boom",
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

describe("NoopDispatcher", () => {
  test("writes dispatch-request.json and reports not dispatched", async () => {
    const writes: Record<string, string> = {}
    const writer = async (name: string, content: string) => {
      writes[name] = content
      return `/tmp/${name}`
    }
    const d = new NoopDispatcher(writer)
    const r = await d.dispatch({
      incident: normalizeIncident({ incidentId: "INC-1", primaryNodeId: "n", issueType: "runtime_exception" }),
      graphContext: fakeGraph(),
      plan: {
        incidentId: "INC-1",
        issueClass: "runtime_exception",
        classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: false },
        strategy: { name: "x", description: "y", agentTasks: [] },
        validationCommands: ["npm test"],
        nextAction: "dispatch_to_opencode",
        rationale: "",
      },
      candidateFiles: ["a.ts"],
      constraints: { timeoutMs: 1000, maxFiles: 1, testCommands: ["npm test"] },
      safetyRules: {
        forbidDestructiveOps: true,
        forbidExternalDirectoryWrites: true,
        forbidShellWithoutAllowlist: true,
        blockingRiskGates: [],
        blockingPolicyViolations: 0,
      },
      requestedOutputs: { patchDiff: true, agentEventsJsonl: true, sessionTranscript: false },
      dryRun: true,
    })
    expect(r.dispatched).toBe(false)
    expect(writes["dispatch-request.json"]).toContain("INC-1")
    expect(writes["dispatch-request.json"]).toContain('"dispatcher": "noop"')
    expect(writes["dispatch-request.json"]).toContain("Phase 1 dispatcher is a no-op")
  })
})

describe("buildSafetyRules", () => {
  test("aggregates blocking gates + policy counts", () => {
    const gates: GateResult[] = [
      { gateId: "a", status: "pass", reason: "", evidence: [] },
      { gateId: "b", status: "requires_approval", reason: "", evidence: [] },
      { gateId: "c", status: "block", reason: "", evidence: [] },
    ]
    const policy: PolicyGateResult = {
      status: "block",
      reason: "x",
      blockingViolations: [{}, {}],
      warningViolations: [],
      raw: {},
    }
    const rules = buildSafetyRules(gates, policy)
    expect(rules.blockingRiskGates).toEqual(["b", "c"])
    expect(rules.blockingPolicyViolations).toBe(2)
    expect(rules.forbidDestructiveOps).toBe(true)
    expect(rules.forbidExternalDirectoryWrites).toBe(true)
  })
})
