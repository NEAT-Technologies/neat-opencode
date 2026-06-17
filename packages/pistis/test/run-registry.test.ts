import { describe, expect, test } from "bun:test"
import { RunRegistry } from "../src/daemon/run-registry"

describe("RunRegistry", () => {
  test("start creates a queued record", () => {
    const r = new RunRegistry()
    const rec = r.start("run-1", "INC-1")
    expect(rec.runId).toBe("run-1")
    expect(rec.status).toBe("queued")
    expect(rec.startedAt).toBeDefined()
    expect(r.size()).toBe(1)
  })

  test("setStatus updates the record", () => {
    const r = new RunRegistry()
    r.start("run-1", "INC-1")
    r.setStatus("run-1", "running")
    expect(r.get("run-1")!.status).toBe("running")
  })

  test("setStatus on terminal status fills finishedAt", () => {
    const r = new RunRegistry()
    r.start("run-1", "INC-1")
    r.setStatus("run-1", "completed", { verdict: "accepted" })
    const rec = r.get("run-1")!
    expect(rec.status).toBe("completed")
    expect(rec.verdict).toBe("accepted")
    expect(rec.finishedAt).toBeDefined()
  })

  test("cancel returns 'cancelling' for in-flight run", () => {
    const r = new RunRegistry()
    r.start("run-1", "INC-1")
    expect(r.cancel("run-1")).toBe("cancelling")
    expect(r.get("run-1")!.status).toBe("cancelled")
  })

  test("cancel returns 'not_found' for unknown run", () => {
    const r = new RunRegistry()
    expect(r.cancel("nope")).toBe("not_found")
  })

  test("cancel returns 'already_finished' for completed run", () => {
    const r = new RunRegistry()
    r.start("run-1", "INC-1")
    r.setStatus("run-1", "completed")
    expect(r.cancel("run-1")).toBe("already_finished")
  })

  test("list returns newest-first", () => {
    const r = new RunRegistry()
    r.start("a", "INC-1")
    r.start("b", "INC-2")
    r.start("c", "INC-3")
    expect(r.list().map((rec) => rec.runId)).toEqual(["c", "b", "a"])
  })

  test("list honours limit", () => {
    const r = new RunRegistry()
    for (let i = 0; i < 5; i++) r.start(`run-${i}`, `INC-${i}`)
    expect(r.list({ limit: 2 }).length).toBe(2)
  })

  test("list honours status filter", () => {
    const r = new RunRegistry()
    r.start("a", "INC-1"); r.setStatus("a", "completed")
    r.start("b", "INC-2"); r.setStatus("b", "running")
    r.start("c", "INC-3"); r.setStatus("c", "completed")
    expect(r.list({ status: "completed" }).map((rec) => rec.runId).sort()).toEqual(["a", "c"])
  })

  test("evicts oldest terminal record when over max", () => {
    const r = new RunRegistry({ max: 3 })
    r.start("a", "i1"); r.setStatus("a", "completed")
    r.start("b", "i2"); r.setStatus("b", "completed")
    r.start("c", "i3"); r.setStatus("c", "completed")
    r.start("d", "i4")
    // 'a' (oldest terminal) should have been evicted
    expect(r.get("a")).toBeUndefined()
    expect(r.get("d")).toBeDefined()
  })

  test("never evicts in-flight runs", () => {
    const r = new RunRegistry({ max: 2 })
    r.start("a", "i1") // queued (non-terminal)
    r.start("b", "i2") // queued
    r.start("c", "i3") // queued; cannot evict anything terminal
    expect(r.get("a")).toBeDefined()
    expect(r.get("b")).toBeDefined()
    expect(r.get("c")).toBeDefined()
    // size went over max because none could be evicted; that's expected
    expect(r.size()).toBeGreaterThan(2)
  })

  test("start twice with same id throws", () => {
    const r = new RunRegistry()
    r.start("a", "i1")
    expect(() => r.start("a", "i2")).toThrow(/duplicate runId/)
  })
})
