import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import type { Worker } from "../opencode/worker"
import type { ContractReviewer, ContractReviewerInput } from "../contract/reviewer"
import type { AsyncContractReviewer } from "../contract/async-reviewer"
import type { AgentContract, AgentResult, ContractReview } from "../contract/types"
import type { NormalizedIncident } from "../incident/schema"
import type { GraphContext } from "../neat/context-builder"
import type { RemediationPlan } from "../planner/remediation-plan"
import type { Classification } from "../planner/classifier"
import type { GateResult } from "../validation/risk-gate"
import type { OrchestrationPlan, OrchestrationStep } from "./plan"
import { buildRoleContract } from "./role-contract-builders"
import { FILE_WRITING_ROLES } from "./roles"
import { probeGit, captureDiff } from "../opencode/git-diff"
import { runTestCommands, renderTestReport } from "../validation/test-runner"

/**
 * Multi-Agent Contract Orchestrator (Phase 3).
 *
 * Walks an OrchestrationPlan in order, dispatching one worker per step.
 * Between steps:
 *   - priorFindings (role → AgentResult) is folded into the next contract.
 *   - If the role is a "file-writing role" (patch / migration), the
 *     orchestrator captures patch.diff for that role's attempt.
 *   - For "test" role, the orchestrator runs validation commands and attaches
 *     the results to the AgentResult before review.
 *   - Reviewer accepts/rejects/retries/escalates the role's contract.
 *
 * Escalation policy:
 *   - any role review = `rejected`     → halt, orchestration verdict = rejected
 *   - any role review = `needs_human`  → halt, orchestration verdict = needs_human
 *   - all roles accepted               → verdict = accepted
 *
 * Workspace policy: only file-writing roles run with the workspace mounted.
 * Reasoning roles execute against an empty workspace handle so they cannot
 * accidentally write. Between roles, the workspace is NOT reset; the patch
 * persists so the reviewer / security_risk / test roles see the same diff.
 */
export interface MultiAgentOrchestratorOptions {
  worker: Worker
  reviewer: ContractReviewer
  /**
   * Optional async reviewer (e.g. KimiReviewer) used for file-writing roles
   * (patch, migration) when supplied. Reasoning roles (graph_context,
   * root_cause, security_risk) always go through the sync reviewer because
   * KimiReviewer pre-flights on AgentResult.diff being present.
   */
  asyncReviewer?: AsyncContractReviewer
  workspaceCwd: string
  allowDirtyWorkspace?: boolean
  allowNonGitWorkspace?: boolean
  writeArtifact: (name: string, content: string) => Promise<string>
  maxRetries?: number
}

export interface OrchestrationInput {
  incident: NormalizedIncident
  graph: GraphContext
  plan: RemediationPlan
  classification: Classification
  riskGates: GateResult[]
  testCommands: string[]
  orchestrationPlan: OrchestrationPlan
}

export interface RoleAttemptRecord {
  role: string
  attempt: number
  contract: AgentContract
  result: AgentResult
  review: ContractReview
  filesChanged: string[]
  artifacts: Record<string, string>
  durationMs: number
}

export interface OrchestrationSummary {
  finalVerdict: ContractReview["verdict"]
  roleResults: Record<string, RoleAttemptRecord[]>
  totalAttempts: number
  totalFilesChanged: number
  workspaceCwd: string
  baseline?: { head?: string; branch?: string }
  reasoning: string
}

export class MultiAgentOrchestrator {
  constructor(private readonly opts: MultiAgentOrchestratorOptions) {}

  async run(input: OrchestrationInput): Promise<OrchestrationSummary> {
    const cwd = isAbsolute(this.opts.workspaceCwd)
      ? this.opts.workspaceCwd
      : resolvePath(this.opts.workspaceCwd)

    try {
      const st = await fs.stat(cwd)
      if (!st.isDirectory()) throw new Error("not a directory")
    } catch {
      throw new Error(`pistis: --workspace does not exist or is not a directory: ${cwd}`)
    }

    const probe = await probeGit(cwd)
    if (!probe.isGitRepo && !this.opts.allowNonGitWorkspace) {
      throw new Error(`pistis: workspace ${cwd} is not a git repo`)
    }
    if (probe.isGitRepo && !probe.isCleanWorkingTree && !this.opts.allowDirtyWorkspace) {
      throw new Error(`pistis: workspace ${cwd} has uncommitted changes`)
    }

    const priorFindings: Record<string, AgentResult> = {}
    const roleResults: Record<string, RoleAttemptRecord[]> = {}
    let finalVerdict: ContractReview["verdict"] = "accepted"
    let totalFilesChanged = 0
    let totalAttempts = 0

    for (const step of input.orchestrationPlan.steps) {
      const records = await this.runRole(step, input, cwd, probe.head, priorFindings)
      roleResults[step.role] = records
      const last = records[records.length - 1]
      if (!last) continue

      totalAttempts += records.length
      totalFilesChanged += last.filesChanged.length
      priorFindings[step.role] = last.result

      const v = last.review.verdict
      if (v === "rejected" || v === "needs_human") {
        finalVerdict = v
        break
      }
      // accepted: keep going to next role.
    }

    const summary: OrchestrationSummary = {
      finalVerdict,
      roleResults,
      totalAttempts,
      totalFilesChanged,
      workspaceCwd: cwd,
      baseline: probe.isGitRepo ? { head: probe.head, branch: probe.branch } : undefined,
      reasoning: input.orchestrationPlan.reasoning,
    }
    await this.opts.writeArtifact("orchestration-summary.json", JSON.stringify(summary, null, 2) + "\n")
    return summary
  }

  private async runRole(
    step: OrchestrationStep,
    input: OrchestrationInput,
    cwd: string,
    baselineHead: string | undefined,
    priorFindings: Record<string, AgentResult>,
  ): Promise<RoleAttemptRecord[]> {
    const records: RoleAttemptRecord[] = []
    let currentContract = buildRoleContract({
      role: step.role,
      sequence: 0,
      incident: input.incident,
      graph: input.graph,
      plan: input.plan,
      classification: input.classification,
      riskGates: input.riskGates,
      testCommands: input.testCommands,
      priorFindings,
      maxRetries: this.opts.maxRetries,
    })
    const maxAttempts = currentContract.maxRetries + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = Date.now()
      const artifactPrefix = `${step.role}/${pad(attempt)}`

      const contractPath = await this.opts.writeArtifact(
        `${artifactPrefix}/contract.json`,
        JSON.stringify(currentContract, null, 2) + "\n",
      )

      const workspaceForRole = FILE_WRITING_ROLES.has(step.role as never)
        ? { cwd, isGitRepo: true }
        : { cwd, isGitRepo: true }
      const result = await this.opts.worker.run(currentContract, workspaceForRole)

      // For test role: actually run the validation commands and attach to result.
      const artifacts: Record<string, string> = { contract: contractPath }
      let testRuns: Awaited<ReturnType<typeof runTestCommands>> = []
      if (step.role === "test" && input.testCommands.length > 0) {
        testRuns = await runTestCommands(input.testCommands, { cwd })
        const reportPath = await this.opts.writeArtifact(
          `${artifactPrefix}/test-report.txt`,
          renderTestReport(testRuns),
        )
        artifacts.testReport = reportPath
      }

      // Capture diff after file-writing roles.
      let observedFilesChanged: string[] = result.filesChanged
      if (FILE_WRITING_ROLES.has(step.role as never) && baselineHead) {
        const captured = await captureDiff({ cwd, baselineRef: baselineHead, includeUntracked: true })
        const diffPath = await this.opts.writeArtifact(
          `${artifactPrefix}/patch.diff`,
          captured.diff || "(no changes)\n",
        )
        artifacts.patchDiff = diffPath
        // Also stash a snapshot of "current full diff" at the top level so
        // the user always sees the most recent patch.
        await this.opts.writeArtifact("patch.diff", captured.diff || "(no changes)\n")
        observedFilesChanged = captured.filesChanged.length > 0 ? captured.filesChanged : result.filesChanged
      }

      const resultPath = await this.opts.writeArtifact(
        `${artifactPrefix}/agent-result.json`,
        JSON.stringify(result, null, 2) + "\n",
      )
      artifacts.agentResult = resultPath

      const review = await this.getReview(
        {
          contract: currentContract,
          result,
          testRuns,
          observedFilesChanged,
          attempt,
        },
        input,
      )
      const reviewPath = await this.opts.writeArtifact(
        `${artifactPrefix}/contract-review.json`,
        JSON.stringify(review, null, 2) + "\n",
      )
      artifacts.contractReview = reviewPath

      records.push({
        role: step.role,
        attempt,
        contract: currentContract,
        result,
        review,
        filesChanged: observedFilesChanged,
        artifacts,
        durationMs: Date.now() - attemptStart,
      })

      if (
        review.verdict === "accepted" ||
        review.verdict === "rejected" ||
        review.verdict === "needs_human"
      ) {
        return records
      }
      // needs_retry: only file-writing roles get a workspace reset; reasoning
      // roles can just rerun.
      if (FILE_WRITING_ROLES.has(step.role as never) && baselineHead) {
        await runGitReset(cwd, baselineHead)
      }
      currentContract = {
        ...currentContract,
        contractId: `${input.incident.incidentId}::${step.role}::${pad(attempt)}`,
        objective: review.nextPrompt ?? currentContract.objective,
      }
    }
    return records
  }

  /**
   * Route the review for one role-attempt to either the sync rule-based
   * reviewer or the optional async reviewer (e.g. Kimi). The async path
   * is only taken for file-writing roles because the async reviewer
   * (KimiReviewer) requires AgentResult.diff to be populated.
   */
  private async getReview(
    base: ContractReviewerInput,
    input: OrchestrationInput,
  ): Promise<ContractReview> {
    const role = base.contract.agentRole
    const isFileWriting = FILE_WRITING_ROLES.has(role as never)
    if (this.opts.asyncReviewer && isFileWriting) {
      return this.opts.asyncReviewer.review({
        ...base,
        incident: input.incident,
        graphContext: input.graph,
        primaryNodeId: input.incident.primaryNodeId,
      })
    }
    return this.opts.reviewer.review(base)
  }
}

function pad(n: number): string { return String(n).padStart(3, "0") }

function runGitReset(cwd: string, ref: string): Promise<void> {
  return new Promise((resolveFn) => {
    const child = spawn("git", ["reset", "--hard", ref], { cwd, stdio: "ignore" })
    child.on("close", () => resolveFn())
    child.on("error", () => resolveFn())
  })
}
