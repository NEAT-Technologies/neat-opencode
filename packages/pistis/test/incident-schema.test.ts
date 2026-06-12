import { describe, expect, test } from "bun:test"
import { normalizeIncident, IncidentValidationError, loadIncidentFile } from "../src/incident/schema"
import * as path from "node:path"

describe("incident schema", () => {
  test("normalizes a full incident", () => {
    const n = normalizeIncident({
      incidentId: "INC-1",
      issueType: "runtime_exception",
      severity: "high",
      primaryNodeId: "service:foo",
      failingEdgeId: "e-1",
      errorId: "err-1",
      message: "boom",
      evidence: [{ kind: "stack", file: "x.ts", line: 10 }],
      candidateFiles: ["a.ts"],
      labels: ["one"],
      metadata: { team: "core" },
    })
    expect(n.incidentId).toBe("INC-1")
    expect(n.issueType).toBe("runtime_exception")
    expect(n.severity).toBe("high")
    expect(n.primaryNodeId).toBe("service:foo")
    expect(n.evidence.length).toBe(1)
    expect(n.candidateFiles).toEqual(["a.ts"])
    expect(n.labels).toEqual(["one"])
    expect(n.metadata.team).toBe("core")
  })

  test("accepts snake_case + id aliases", () => {
    const n = normalizeIncident({
      id: "INC-2",
      issue_type: "policy_violation",
      primary_node_id: "service:bar",
      failing_edge_id: "e-2",
      error_id: "err-2",
      summary: "policy thing",
      candidate_files: ["b.ts"],
      tags: ["t"],
    })
    expect(n.incidentId).toBe("INC-2")
    expect(n.issueType).toBe("policy_violation")
    expect(n.primaryNodeId).toBe("service:bar")
    expect(n.failingEdgeId).toBe("e-2")
    expect(n.errorId).toBe("err-2")
    expect(n.message).toBe("policy thing")
    expect(n.candidateFiles).toEqual(["b.ts"])
    expect(n.labels).toEqual(["t"])
  })

  test("evidence as single object becomes array", () => {
    const n = normalizeIncident({
      incidentId: "INC-3",
      primaryNodeId: "n",
      evidence: { message: "one" },
    })
    expect(n.evidence.length).toBe(1)
    expect(n.evidence[0]!.message).toBe("one")
  })

  test("coerces fuzzy severities", () => {
    expect(normalizeIncident({ id: "1", nodeId: "n", severity: "p1" }).severity).toBe("critical")
    expect(normalizeIncident({ id: "1", nodeId: "n", severity: "warn" }).severity).toBe("low")
    expect(normalizeIncident({ id: "1", nodeId: "n", severity: "ERROR" }).severity).toBe("high")
    expect(normalizeIncident({ id: "1", nodeId: "n" }).severity).toBe("medium")
  })

  test("throws when incidentId is missing", () => {
    expect(() => normalizeIncident({ nodeId: "n" })).toThrow(IncidentValidationError)
  })

  test("throws when primaryNodeId is missing", () => {
    expect(() => normalizeIncident({ id: "x" })).toThrow(IncidentValidationError)
  })

  test("loadIncidentFile parses from disk", async () => {
    const file = path.resolve(__dirname, "..", "examples", "incident.json")
    const n = await loadIncidentFile(file)
    expect(n.incidentId).toBe("INC-2026-0001")
    expect(n.primaryNodeId).toBe("service:checkout-api")
  })

  test("loadIncidentFile rejects bad JSON", async () => {
    const tmp = path.join(import.meta.dir, ".tmp-bad-json")
    await Bun.write(tmp, "{not json")
    await expect(loadIncidentFile(tmp)).rejects.toBeInstanceOf(IncidentValidationError)
    await Bun.file(tmp)
      .stream()
      .cancel()
      .catch(() => undefined)
    await import("node:fs/promises").then((fs) => fs.unlink(tmp).catch(() => undefined))
  })
})
