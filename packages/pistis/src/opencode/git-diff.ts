import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { join } from "node:path"

/**
 * Tiny git helpers used by OpenCodeSessionDispatcher to verify workspace
 * cleanliness, baseline HEAD, and capture the worker's diff.
 *
 * We shell out to `git` rather than depending on a JS library: it's the
 * one tool we know is on the host any time the user is reviewing a fix.
 */

export interface GitProbe {
  isGitRepo: boolean
  isCleanWorkingTree: boolean
  head?: string
  branch?: string
}

export async function probeGit(cwd: string): Promise<GitProbe> {
  if (!(await dirExists(cwd))) return { isGitRepo: false, isCleanWorkingTree: false }
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"])
  if (top.exitCode !== 0) return { isGitRepo: false, isCleanWorkingTree: false }
  const head = await runGit(cwd, ["rev-parse", "HEAD"])
  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const status = await runGit(cwd, ["status", "--porcelain"])
  return {
    isGitRepo: true,
    isCleanWorkingTree: status.exitCode === 0 && status.stdout.trim().length === 0,
    head: head.exitCode === 0 ? head.stdout.trim() : undefined,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : undefined,
  }
}

/**
 * Capture `git diff` between baselineRef (default: HEAD) and the current
 * working tree. Returns the full unified diff and a list of changed files
 * (relative paths). Untracked files are explicitly NOT included unless
 * `includeUntracked` is true — in which case we shell out to
 * `git ls-files --others --exclude-standard` to enumerate them and inline
 * their contents as add-hunks.
 */
export interface CaptureDiffOptions {
  cwd: string
  baselineRef?: string
  includeUntracked?: boolean
}

export interface CapturedDiff {
  diff: string
  filesChanged: string[]
  /** True if the diff body exceeds the cap and has been truncated. */
  truncated: boolean
}

const DIFF_CAP_BYTES = 1024 * 1024 // 1 MiB

export async function captureDiff(opts: CaptureDiffOptions): Promise<CapturedDiff> {
  const baseline = opts.baselineRef ?? "HEAD"
  const tracked = await runGit(opts.cwd, ["diff", "--no-color", baseline])
  let diff = tracked.exitCode === 0 ? tracked.stdout : ""

  const namesRes = await runGit(opts.cwd, ["diff", "--name-only", baseline])
  const filesChanged: string[] = namesRes.exitCode === 0
    ? namesRes.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
    : []

  if (opts.includeUntracked) {
    const u = await runGit(opts.cwd, ["ls-files", "--others", "--exclude-standard"])
    if (u.exitCode === 0) {
      const untrackedFiles = u.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
      for (const f of untrackedFiles) {
        if (filesChanged.includes(f)) continue
        const abs = join(opts.cwd, f)
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat || !stat.isFile()) continue
        const content = await fs.readFile(abs, "utf8").catch(() => null)
        if (content === null) continue
        const lines = content.split("\n")
        diff +=
          `\ndiff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join("\n") +
          "\n"
        filesChanged.push(f)
      }
    }
  }

  let truncated = false
  if (diff.length > DIFF_CAP_BYTES) {
    truncated = true
    diff = diff.slice(0, DIFF_CAP_BYTES) + `\n... [truncated at ${DIFF_CAP_BYTES} bytes]\n`
  }

  return { diff, filesChanged: [...new Set(filesChanged)].sort(), truncated }
}

interface RunResult { exitCode: number; stdout: string; stderr: string }

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolveFn) => {
    let stdout = ""
    let stderr = ""
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")))
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")))
    child.on("error", () => resolveFn({ exitCode: -1, stdout, stderr: stderr + "spawn error" }))
    child.on("close", (code) => resolveFn({ exitCode: code ?? -1, stdout, stderr }))
  })
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}
