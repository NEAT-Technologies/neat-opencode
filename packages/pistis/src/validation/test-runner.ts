/**
 * Phase 1 test-runner stub.
 *
 * Phase 1 must not run arbitrary shell commands. This module is included so
 * Phase 2 can implement actual command execution against `--test-command`
 * inputs without restructuring the surrounding code, but in Phase 1 it only
 * records the intended commands as artifacts.
 */

export interface TestRunResult {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  /** True when the run was deferred to Phase 2 because --dry-run was set. */
  deferred: boolean
}

export interface PlannedTestRun {
  command: string
  /** Why it isn't running yet — usually "phase 1 dry run". */
  deferredReason: string
}

/**
 * Phase 1: never executes. Returns the planned commands so the artifact records
 * exactly what Phase 2 will run.
 */
export function planTestRuns(commands: string[], reason = "phase 1 dry run"): PlannedTestRun[] {
  return commands.map((command) => ({ command, deferredReason: reason }))
}
