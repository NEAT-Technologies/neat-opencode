import { spawn } from "node:child_process"

export interface GitApplyResult {
  ok: boolean
  stderr: string
}

export type GitApplyFn = (cwd: string, diff: string) => Promise<GitApplyResult>

/**
 * Run `git apply --whitespace=nowarn` against `cwd`, feeding the diff on
 * stdin. Returns `{ ok, stderr }`. Does not throw on non-zero exit; the
 * caller decides how to surface the failure to the AgentResult.
 *
 * No --3way: requires `index abc..def` SHAs that the model can't reliably
 * compute. Plain git apply is what we want for model-emitted diffs.
 */
export const defaultGitApply: GitApplyFn = (cwd, diff) =>
  new Promise<GitApplyResult>((resolve) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn"], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    let cap = 0
    const CAP = 8 * 1024
    child.stderr.on("data", (chunk: Buffer) => {
      if (cap < CAP) {
        const remaining = CAP - cap
        stderr += chunk.subarray(0, remaining).toString("utf8")
        cap += Math.min(chunk.length, remaining)
      }
    })
    child.on("error", () => resolve({ ok: false, stderr: stderr || "git not found" }))
    child.on("close", (code) => resolve({ ok: code === 0, stderr }))
    child.stdin.end(diff)
  })
