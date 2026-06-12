import { describe, expect, test } from "bun:test"
import { renderFinalReport } from "../src/report/final-report"
import { normalizeIncident } from "../src/incident/schema"
import type { GraphContext } from "../src/neat/context-builder"

function fakeGraph(): GraphContext {
  return {
    neat: { baseUrl: "http://x", project: "demo", healthOk: true },
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
      edges: { status: "ok", endpoint: "/graph/edges/n", data: {} },
      rootCause: { status: "unavailable", endpoint: "/graph/root-cause/n", error: "404" },
      blastRadius: { status: "ok", endpoint: "/graph/blast-radius/n", data: { affectedNodes: [] } },
      dependencies: { status: "unavailable", endpoint: "/graph/dependencies/n", error: "404" },
      divergences: { status: "ok", endpoint: "/graph/divergences", data: {} },
      incidentsForNode: { status: "ok", endpoint: "/incidents/n", data: {} },
      policyViolations: { status: "ok", endpoint: "/policies/violations", data: { violations: [] } },
    },
    unavailable: [
      { section: "rootCause", endpoint: "/graph/root-cause/n", error: "404" },
      { section: "dependencies", endpoint: "/graph/dependencies/n", error: "404" },
    ],
  }
}

describe("renderFinalReport", () => {
  test("includes all required sections and marks dry run", () => {
    const md = renderFinalReport({
      incident: normalizeIncident({
        incidentId: "INC-9",
        primaryNodeId: "n",
        severity: "high",
        message: "boom",
        failingEdgeId: "e-1",
        errorId: "err-1",
      }),
      graph: fakeGraph(),
      classification: { class: "runtime_exception", confidence: "high", reasons: ["explicit"] },
      plan: {
        incidentId: "INC-9",
        issueClass: "runtime_exception",
        classificationReasons: [],
        affected: { primaryNodeId: "n", candidateFiles: [], blastRadiusConsidered: true },
        strategy: { name: "isolate-and-patch", description: "x", agentTasks: [] },
        validationCommands: [],
        nextAction: "dispatch_to_opencode",
        rationale: "",
      },
      riskGates: [{ gateId: "destructive_change", status: "pass", reason: "ok", evidence: [] }],
      policy: {
        status: "pass",
        reason: "ok",
        blockingViolations: [],
        warningViolations: [],
        raw: {},
      },
      dispatch: {
        dispatched: false,
        reason: "dry run",
        artifactPath: "/tmp/dispatch-request.json",
        dispatchedAt: "2026-06-10T00:00:00Z",
      },
      artifactsWritten: ["incident.json", "graph-context.json", "plan.md", "validation.json", "dispatch-request.json"],
      runDir: "/tmp/run",
      dryRun: true,
      phase: 1,
    })
    expect(md).toContain("# Pistis Final Report — INC-9")
    expect(md).toContain("Phase 1")
    expect(md).toContain("dry run")
    expect(md).toContain("**No code was modified.**")
    expect(md).toContain("base URL: `http://x`")
    expect(md).toContain("project: `demo`")
    expect(md).toContain("rootCause")
    expect(md).toContain("blast-radius")
    expect(md).toContain("Risk gates")
    expect(md).toContain("Policy gate")
    expect(md).toContain("Dispatch")
    expect(md).toContain("Artifacts written")
  })
})
