import { promises as fs } from "node:fs"
import { resolve as resolvePath, isAbsolute } from "node:path"
import type {
  RemediationDispatcher,
  RemediationDispatchInput,
  RemediationDispatchResult,
} from "./dispatcher"
import type { Worker } from "./worker"
import type { ContractReviewer } from "../contract/reviewer"
import type { AgentContract, AgentResult, ContractReview } from "../contract/types"
import { buildAgentContract } from "../contract/builder"
import { probeGit, captureDiff } from "./git-diff"
import { runTestCommands, renderTestReport } from "../validation/test-runner"

/**
 * Phase 2 dispatcher. Runs ONE worker per AgentContract, with a retry loop
 * driven by ContractReview verdicts.
 *
 * Flow:
 *   1. Validate workspace (git repo + clean working tree).
 *   2. Capture baseline HEAD.
 *   3. Build first AgentContract from incident+graph+plan.
 *   4. For attempt 1..(maxRetries+1):
 *        a. worker.run(contract)
 *        b. captureDiff() → patch.diff
 *        c. runTestCommands() → test-report.txt
 *        d. reviewer.review(contract, result, observedFilesChanged, testRuns, attempt)
 *        e. write contract-{N}.json + agent-result-{N}.json + contract-review-{N}.json
 *        f. if accepted → done
 *        g. if needs_retry → reset workspace to baseline, build next contract with refined prompt
 *        h. else (rejected | needs_human) → done
 *   5. Always write final patch.diff (most recent attempt's diff).
 */

export interface OpenCodeSessionDispatcherOptions {
  worker: Worker
  reviewer: ContractReviewer
  /** Host workspace where the worker operates. Must be a clean git repo. */
  workspaceCwd: string
  /** Allow workers to operate without a git repo (StubWorker/CI). Default false. */
  allowNonGitWorkspace?: boolean
  /** Allow a dirty workspace (developer convenience). Default false: refuse to start. */
  allowDirtyWorkspace?: boolean
  /** Used to write dispatcher-owned artifacts (patch.diff, test-report.txt, contract-N.json, ...). */
  writeArtifact: (name: string, content: string) => Promise<string>
}

export interface DispatchSummary {
  attempts: AttemptRecord[]
  finalVerdict: ContractReview["verdict"] | "no_run"
  totalFilesChanged: number
  totalTestsRun: number
  workspaceCwd: string
  baseline?: { head?: string; branch?: string }
}

export interface AttemptRecord {
  attempt: number
  contract: AgentContract
  result: AgentResult
  review: ContractReview
  testsExitedZero: number
  testsExitedNonZero: number
  filesChanged: string[]
  durationMs: number
  artifacts: { contractPath: string; resultPath: string; reviewPath: string }
}

export class OpenCodeSessionDispatcher implements RemediationDispatcher {
  readonly name = "opencode-session"
  constructor(private readonly opts: OpenCodeSessionDispatcherOptions) {}

  async dispatch(input: RemediationDispatchInput): Promise<RemediationDispatchResult> {
    const dispatchedAt = new Date().toISOString()

    if (input.dryRun) {
      return {
        dispatched: false,
        reason: "dry-run: OpenCodeSessionDispatcher refused to spawn a worker",
        dispatchedAt,
      }
    }

    const cwd = isAbsolute(this.opts.workspaceCwd)
      ? this.opts.workspaceCwd
      : resolvePath(this.opts.workspaceCwd)

    // Guard: workspace must exist.
    try {
      const st = await fs.stat(cwd)
      if (!st.isDirectory()) throw new Error("not a directory")
    } catch {
      throw new Error(`pistis: --workspace does not exist or is not a directory: ${cwd}`)
    }

    const probe = await probeGit(cwd)
    if (!probe.isGitRepo && !this.opts.allowNonGitWorkspace) {
      throw new Error(
        `pistis: workspace ${cwd} is not a git repo. Initialize one or pass --allow-non-git-workspace.`,
      )
    }
    if (probe.isGitRepo && !probe.isCleanWorkingTree && !this.opts.allowDirtyWorkspace) {
      throw new Error(
        `pistis: workspace ${cwd} has uncommitted changes. Commit/stash them first or pass --allow-dirty-workspace.`,
      )
    }

    const attempts: AttemptRecord[] = []
    let currentContract = buildAgentContract({
      incident: input.incident,
      graph: input.graphContext,
      plan: input.plan,
      classification: { class: input.plan.issueClass, reasons: [], confidence: "high" },
      riskGates: [],
      testCommands: input.constraints.testCommands,
    })

    const maxAttempts = currentContract.maxRetries + 1
    let finalVerdict: ContractReview["verdict"] = "needs_human"
    let lastDiffPath: string | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = Date.now()

      // Write the contract for this attempt.
      const contractPath = await this.opts.writeArtifact(
        `contract-${pad(attempt)}.json`,
        JSON.stringify(currentContract, null, 2) + "\n",
      )

      // Hand off to the worker.
      const result = await this.opts.worker.run(currentContract, {
        cwd,
        isGitRepo: probe.isGitRepo,
      })
      const resultPath = await this.opts.writeArtifact(
        `agent-result-${pad(attempt)}.json`,
        JSON.stringify(result, null, 2) + "\n",
      )

      // Capture diff. If no git repo, derive observed files from the worker.
      let observedFilesChanged: string[] = result.filesChanged
      if (probe.isGitRepo) {
        const captured = await captureDiff({
          cwd,
          baselineRef: probe.head ?? "HEAD",
          includeUntracked: true,
        })
        lastDiffPath = await this.opts.writeArtifact("patch.diff", captured.diff || "(no changes)\n")
        observedFilesChanged = captured.filesChanged.length > 0
          ? captured.filesChanged
          : result.filesChanged
      } else {
        lastDiffPath = await this.opts.writeArtifact(
          "patch.diff",
          result.diff ?? "(no diff: workspace is not a git repo)\n",
        )
      }

      // Run validation commands (if any).
      let testRuns: Awaited<ReturnType<typeof runTestCommands>> = []
      if (input.constraints.testCommands.length > 0) {
        testRuns = await runTestCommands(input.constraints.testCommands, {
          cwd,
          timeoutMs: input.constraints.timeoutMs,
        })
        await this.opts.writeArtifact("test-report.txt", renderTestReport(testRuns))
      }

      // Review.
      const review = this.opts.reviewer.review({
        contract: currentContract,
        result,
        testRuns,
        observedFilesChanged,
        attempt,
      })
      const reviewPath = await this.opts.writeArtifact(
        `contract-review-${pad(attempt)}.json`,
        JSON.stringify(review, null, 2) + "\n",
      )

      attempts.push({
        attempt,
        contract: currentContract,
        result,
        review,
        testsExitedZero: testRuns.filter((r) => r.exitCode === 0).length,
        testsExitedNonZero: testRuns.filter((r) => r.exitCode !== 0).length,
        filesChanged: observedFilesChanged,
        durationMs: Date.now() - attemptStart,
        artifacts: { contractPath, resultPath, reviewPath },
      })

      finalVerdict = review.verdict
      if (review.verdict === "accepted" || review.verdict === "rejected" || review.verdict === "needs_human") {
        break
      }

      // needs_retry: roll the workspace back to baseline so the next attempt
      // starts from a clean slate, then build a refined contract.
      if (probe.isGitRepo && probe.head) {
        await runGitReset(cwd, probe.head)
      }
      currentContract = {
        ...currentContract,
        contractId: `${input.incident.incidentId}::${currentContract.agentRole}::${pad(attempt)}`,
        objective: review.nextPrompt ?? currentContract.objective,
      }
    }

    // Write a top-level dispatch-summary capturing the loop.
    const summary: DispatchSummary = {
      attempts: attempts.map((a) => ({
        ...a,
        // strip the heavy graphContext from each attempt's stored contract to
        // keep dispatch-summary.json small; the full contract-N.json is
        // already on disk.
        contract: { ...a.contract, graphContext: "[see graph-context.json]" } as AgentContract,
      })),
      finalVerdict,
      totalFilesChanged: attempts.reduce((n, a) => n + a.filesChanged.length, 0),
      totalTestsRun: attempts.reduce((n, a) => n + a.testsExitedZero + a.testsExitedNonZero, 0),
      workspaceCwd: cwd,
      baseline: probe.isGitRepo ? { head: probe.head, branch: probe.branch } : undefined,
    }
    const summaryPath = await this.opts.writeArtifact(
      "dispatch-summary.json",
      JSON.stringify(summary, null, 2) + "\n",
    )

    const dispatched = finalVerdict === "accepted"
    return {
      dispatched,
      reason: `final verdict: ${finalVerdict} after ${attempts.length} attempt(s)`,
      artifactPath: lastDiffPath ?? summaryPath,
      dispatchedAt,
      ...({ dispatchSummary: summary } as Record<string, unknown>),
    }
  }
}

function pad(n: number): string { return String(n).padStart(3, "0") }

import { spawn } from "node:child_process"
function runGitReset(cwd: string, ref: string): Promise<void> {
  return new Promise((resolveFn) => {
    const child = spawn("git", ["reset", "--hard", ref], { cwd, stdio: "ignore" })
    child.on("close", () => resolveFn())
    child.on("error", () => resolveFn())
  })
}
