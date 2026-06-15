import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runTestCommands, planTestRuns, renderTestReport } from "../src/validation/test-runner"

describe("planTestRuns", () => {
  test("returns one entry per command with deferred reason", () => {
    const plans = planTestRuns(["a", "b"], "test")
    expect(plans).toEqual([
      { command: "a", deferredReason: "test" },
      { command: "b", deferredReason: "test" },
    ])
  })
})

describe("runTestCommands", () => {
  test("captures stdout, exit code, duration for a passing command", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-tr-"))
    try {
      const r = await runTestCommands(["printf 'hi'"], { cwd: dir })
      expect(r.length).toBe(1)
      expect(r[0]!.exitCode).toBe(0)
      expect(r[0]!.stdout).toBe("hi")
      expect(r[0]!.durationMs).toBeGreaterThanOrEqual(0)
      expect(r[0]!.timedOut).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("captures nonzero exit code", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-tr-"))
    try {
      const r = await runTestCommands(["exit 2"], { cwd: dir })
      expect(r[0]!.exitCode).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("respects per-command timeout", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-tr-"))
    try {
      const r = await runTestCommands(["sleep 5"], { cwd: dir, timeoutMs: 200 })
      expect(r[0]!.timedOut).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("renderTestReport", () => {
  test("renders empty case", () => {
    expect(renderTestReport([])).toContain("No validation commands")
  })

  test("includes exit codes, stdout/stderr labels, and a summary line", () => {
    const out = renderTestReport([
      { command: "ok", exitCode: 0, stdout: "yes", stderr: "", durationMs: 1, deferred: false, timedOut: false },
      { command: "bad", exitCode: 1, stdout: "", stderr: "boom", durationMs: 2, deferred: false, timedOut: false },
    ])
    expect(out).toContain("$ ok")
    expect(out).toContain("exit=0")
    expect(out).toContain("exit=1")
    expect(out).toContain("stdout")
    expect(out).toContain("stderr")
    expect(out).toContain("1/2 commands passed")
  })
})
