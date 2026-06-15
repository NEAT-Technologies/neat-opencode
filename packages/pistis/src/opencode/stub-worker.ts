import { promises as fs } from "node:fs"
import { join, resolve, relative } from "node:path"
import type { Worker, WorkerWorkspace } from "./worker"
import type { AgentContract, AgentResult } from "../contract/types"

/**
 * Deterministic test/CI worker.
 *
 * Behavior:
 *   - For each allowedFile: if the file exists in workspace.cwd, append a
 *     short PISTIS_NOTE comment. If it doesn't exist, skip (don't create
 *     new files unless `createMissing` is set).
 *   - Always writes/overwrites `PISTIS_PROPOSED_FIX.md` summarizing the
 *     intended change. This guarantees a non-empty diff so the contract's
 *     "at least one file changed" criterion is satisfied for tests.
 *   - Honors `forbiddenFiles`: silently skips any allowedFile that's also in
 *     forbiddenFiles (defense-in-depth; the contract builder shouldn't put
 *     a file in both lists).
 *
 * `failMode` lets tests force the worker into specific bad shapes:
 *   - "none"          : normal behavior (succeed)
 *   - "no_changes"    : touch nothing (criterion "at least one file changed" fails)
 *   - "out_of_scope"  : write a file outside allowedFiles (rejected by reviewer)
 *   - "blocked"       : return status="blocked"
 *   - "no_summary"    : empty summary (criterion "explains the root cause" fails)
 */
export type StubWorkerFailMode = "none" | "no_changes" | "out_of_scope" | "blocked" | "no_summary"

export interface StubWorkerOptions {
  failMode?: StubWorkerFailMode
  createMissingAllowedFiles?: boolean
}

export class StubWorker implements Worker {
  readonly name = "stub-worker"
  constructor(private readonly opts: StubWorkerOptions = {}) {}

  async run(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
    const mode = this.opts.failMode ?? "none"

    if (mode === "blocked") {
      return {
        contractId: contract.contractId,
        status: "blocked",
        summary: "stub worker simulated a blocked state (e.g. missing credentials or external dependency)",
        filesChanged: [],
        testsRun: [],
        riskNotes: ["simulated block"],
        unresolvedQuestions: ["how should pistis proceed when the worker is blocked upstream?"],
      }
    }

    if (mode === "no_changes") {
      return {
        contractId: contract.contractId,
        status: "completed",
        summary: "stub worker analyzed the incident but decided no changes were needed",
        filesChanged: [],
        testsRun: [],
        riskNotes: [],
        unresolvedQuestions: [],
      }
    }

    const filesChanged: string[] = []

    for (const allowed of contract.allowedFiles) {
      if (contract.forbiddenFiles.includes(allowed)) continue
      const abs = safeResolve(workspace.cwd, allowed)
      if (!abs) continue
      const exists = await fileExists(abs)
      if (!exists && !this.opts.createMissingAllowedFiles) continue
      const content = exists ? await fs.readFile(abs, "utf8").catch(() => "") : ""
      const stamped = content + (content.endsWith("\n") || content === "" ? "" : "\n") +
        `\n// PISTIS_NOTE (${contract.contractId}): considered for remediation\n`
      await fs.writeFile(abs, stamped, "utf8")
      filesChanged.push(allowed)
    }

    // If we couldn't touch any allowedFile (none on disk, or no allowedFiles),
    // write a fallback note so the diff is non-empty. This file is intentionally
    // OUTSIDE allowedFiles and the reviewer will reject it — that's correct
    // behavior: if Pistis has no concrete file to edit, it should escalate.
    if (filesChanged.length === 0) {
      const fixPath = "PISTIS_PROPOSED_FIX.md"
      const fixAbs = safeResolve(workspace.cwd, fixPath)
      if (fixAbs) {
        await fs.writeFile(fixAbs, renderProposedFix(contract), "utf8")
        filesChanged.push(fixPath)
      }
    }

    if (mode === "out_of_scope") {
      // intentionally write outside allowedFiles to test the reviewer
      const escapePath = "PISTIS_OUT_OF_SCOPE.md"
      const escapeAbs = safeResolve(workspace.cwd, escapePath)
      if (escapeAbs) {
        await fs.writeFile(escapeAbs, "out of scope file (test)\n", "utf8")
        filesChanged.push(escapePath)
      }
    }

    const summary =
      mode === "no_summary"
        ? ""
        : `Stub worker drafted a proposed remediation note for ${contract.contractId}. Touched ${filesChanged.length} file(s).`

    return {
      contractId: contract.contractId,
      status: "completed",
      summary,
      filesChanged: [...new Set(filesChanged)].sort(),
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: [],
    }
  }
}

function safeResolve(root: string, rel: string): string | null {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  if (r.startsWith("..") || r === "" || r.startsWith("/")) return null
  return abs
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

function renderProposedFix(contract: AgentContract): string {
  const lines: string[] = []
  lines.push(`# Proposed remediation (stub worker)`)
  lines.push(``)
  lines.push(`Contract: \`${contract.contractId}\``)
  lines.push(`Role: \`${contract.agentRole}\``)
  lines.push(``)
  lines.push(`## Objective`)
  lines.push(``)
  lines.push(contract.objective)
  lines.push(``)
  lines.push(`## Allowed files`)
  lines.push(``)
  if (contract.allowedFiles.length === 0) lines.push(`_None provided._`)
  for (const f of contract.allowedFiles) lines.push(`- \`${f}\``)
  lines.push(``)
  lines.push(`## Constraints`)
  lines.push(``)
  for (const c of contract.constraints) lines.push(`- ${c}`)
  lines.push(``)
  return join("", lines.join("\n"))
}
