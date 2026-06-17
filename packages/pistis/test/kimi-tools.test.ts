import { describe, expect, test } from "bun:test"
import { READ_ONLY_TOOLS, TOOL_NAMES } from "../src/reviewers/kimi-tools"

describe("READ_ONLY_TOOLS", () => {
  test("exposes exactly 8 tools", () => {
    expect(READ_ONLY_TOOLS.length).toBe(8)
  })

  test("tool names match TOOL_NAMES allowlist exactly", () => {
    const namesFromTools = new Set(READ_ONLY_TOOLS.map((t) => t.function.name))
    const allowlist = new Set(TOOL_NAMES)
    expect(namesFromTools).toEqual(allowlist)
  })

  test("each tool has a non-trivial description", () => {
    for (const t of READ_ONLY_TOOLS) {
      expect(t.function.description.length).toBeGreaterThan(40)
    }
  })

  test("each tool's parameters block has a type=object root", () => {
    for (const t of READ_ONLY_TOOLS) {
      const params = t.function.parameters as { type?: unknown }
      expect(params.type).toBe("object")
    }
  })

  test("tools that take nodeId list it as required", () => {
    const tools = ["get_node", "get_edges", "get_blast_radius", "get_dependencies", "get_root_cause"] as const
    for (const name of tools) {
      const t = READ_ONLY_TOOLS.find((x) => x.function.name === name)!
      const params = t.function.parameters as { required?: string[]; properties?: Record<string, unknown> }
      expect(params.required).toContain("nodeId")
      expect(params.properties?.nodeId).toBeDefined()
    }
  })

  test("optional-arg tools do NOT mark anything as required", () => {
    const tools = ["get_divergences", "list_incidents", "get_policy_violations"] as const
    for (const name of tools) {
      const t = READ_ONLY_TOOLS.find((x) => x.function.name === name)!
      const params = t.function.parameters as { required?: string[] }
      expect(params.required ?? []).toEqual([])
    }
  })

  test("get_blast_radius depth has range 1..3", () => {
    const t = READ_ONLY_TOOLS.find((x) => x.function.name === "get_blast_radius")!
    const props = (t.function.parameters as any).properties
    expect(props.depth.minimum).toBe(1)
    expect(props.depth.maximum).toBe(3)
  })

  test("no tool exposes a write method shape (allowlist invariant)", () => {
    // Sanity: no tool name matches anything like 'check_policies', 'create_*', 'post_*', etc.
    for (const t of READ_ONLY_TOOLS) {
      expect(t.function.name).not.toMatch(/^(check|create|post|put|delete|update|set|apply)_/)
    }
  })

  test("READ_ONLY_TOOLS array is frozen", () => {
    expect(Object.isFrozen(READ_ONLY_TOOLS)).toBe(true)
  })
})
