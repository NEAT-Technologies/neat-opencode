import { spawn } from "node:child_process"

/**
 * Test/validation command runner. Phase 1 only planned runs; Phase 2 also
 * executes them via `runTestCommands()`.
 *
 * Hard rules:
 *   - Only the commands explicitly passed to `runTestCommands()` ever run.
 *     There is no broad shell permission; the caller must pass the exact
 *     command string that came from `--test-command`.
 *   - stdout/stderr are captured but truncated to a per-stream cap so a
 *     runaway test can't blow up the artifact file.
 *   - Each command has a wall-clock timeout; on timeout it's SIGKILLed and
 *     `timedOut` is set.
 */

export interface TestRunResult {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  /** True when execution was deferred (dry-run). */
  deferred: boolean
  /** True when the command was killed because of timeout. */
  timedOut: boolean
}

export interface PlannedTestRun {
  command: string
  /** Why it isn't running yet — usually "phase 1 dry run". */
  deferredReason: string
}

export interface RunTestCommandOptions {
  /** Working directory. Required for Phase 2 execution. */
  cwd: string
  /** Per-command wall-clock timeout. Default 5 min. */
  timeoutMs?: number
  /** Optional env overlay. */
  env?: Record<string, string>
  /** Per-stream capture cap in bytes. Default 256 KiB. */
  maxStreamBytes?: number
}

/** Phase 1: never executes. Returns the planned commands so the artifact records exactly what Phase 2 will run. */
export function planTestRuns(commands: string[], reason = "phase 1 dry run"): PlannedTestRun[] {
  return commands.map((command) => ({ command, deferredReason: reason }))
}

/** Phase 2: actually runs each command sequentially in `cwd`. */
export async function runTestCommands(
  commands: string[],
  opts: RunTestCommandOptions,
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = []
  for (const command of commands) {
    results.push(await runOne(command, opts))
  }
  return results
}

async function runOne(command: string, opts: RunTestCommandOptions): Promise<TestRunResult> {
  const start = Date.now()
  const cap = opts.maxStreamBytes ?? 256 * 1024
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  return new Promise<TestRunResult>((resolveFn) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < cap) stdout = trimCap(stdout + b.toString("utf8"), cap)
    })
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < cap) stderr = trimCap(stderr + b.toString("utf8"), cap)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveFn({
        command,
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        deferred: false,
        timedOut,
      })
    })
  })
}

function trimCap(s: string, cap: number): string {
  if (s.length <= cap) return s
  const truncMarker = `\n... [truncated at ${cap} bytes]\n`
  return s.slice(0, cap - truncMarker.length) + truncMarker
}

/** Renders TestRunResults as `test-report.txt`. */
export function renderTestReport(results: TestRunResult[]): string {
  if (results.length === 0) return "No validation commands were run.\n"
  const lines: string[] = []
  for (const r of results) {
    lines.push(`$ ${r.command}`)
    lines.push(`  exit=${r.exitCode} duration=${r.durationMs}ms${r.timedOut ? " timedOut=true" : ""}`)
    if (r.stdout.trim().length > 0) {
      lines.push(`  --- stdout ---`)
      for (const l of r.stdout.split("\n")) lines.push(`  ${l}`)
    }
    if (r.stderr.trim().length > 0) {
      lines.push(`  --- stderr ---`)
      for (const l of r.stderr.split("\n")) lines.push(`  ${l}`)
    }
    lines.push("")
  }
  const passed = results.filter((r) => r.exitCode === 0).length
  lines.push(`Summary: ${passed}/${results.length} commands passed (exit=0).`)
  return lines.join("\n") + "\n"
}
