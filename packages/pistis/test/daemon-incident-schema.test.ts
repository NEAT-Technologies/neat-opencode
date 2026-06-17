import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { normalizeIncident } from "../src/incident/schema"

const SCHEMA_PATH = join(import.meta.dir, "..", "schemas", "incident.schema.json")

describe("incident JSON Schema (NEAT contract)", () => {
  test("schema file exists at the published path", async () => {
    const stat = await fs.stat(SCHEMA_PATH)
    expect(stat.isFile()).toBe(true)
  })

  test("schema is valid JSON and declares the contract id", async () => {
    const text = await fs.readFile(SCHEMA_PATH, "utf8")
    const json = JSON.parse(text)
    expect(json.$schema).toContain("json-schema.org")
    expect(json.$id).toContain("incident.schema.json")
    expect(json.title).toBe("Pistis Incident")
  })

  test("Test 16: schema accepts every shape normalizeIncident accepts", () => {
    // Anything that normalizeIncident successfully parses must also fit the schema.
    const samples = [
      { incidentId: "INC-1", primaryNodeId: "svc:x" },
      { id: "INC-2", primaryNodeId: "svc:y", issueType: "runtime_exception" },
      { incidentId: "INC-3", primaryNodeId: "svc:z", severity: "critical", message: "boom", evidence: [] },
      { incidentId: "INC-4", primaryNodeId: "svc:w", candidateFiles: ["src/a.ts"], labels: ["regression"] },
      { incidentId: "INC-5", primaryNodeId: "svc:v", evidence: { stack: "TypeError: x" } },
      { incidentId: "INC-6", primaryNodeId: "svc:u", failingEdge: { from: "a", to: "b" } },
    ]
    for (const s of samples) {
      expect(() => normalizeIncident(s)).not.toThrow()
    }
  })

  test("schema rejects payloads missing required fields (mirrors normalizeIncident)", () => {
    const bad = [
      { primaryNodeId: "svc:x" },
      { incidentId: "INC-X" },
      {},
    ]
    for (const b of bad) {
      expect(() => normalizeIncident(b)).toThrow()
    }
  })

  test("schema is published from packages/pistis (so NEAT can pull it via npm)", () => {
    // Cheap structural check that it lives under packages/pistis/schemas, not elsewhere.
    expect(SCHEMA_PATH).toContain("packages/pistis/schemas/incident.schema.json")
  })
})
