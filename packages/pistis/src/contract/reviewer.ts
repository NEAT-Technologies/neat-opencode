import type { AgentContract, AgentResult, ContractReview, CriterionResult } from "./types"
import type { TestRunResult } from "../validation/test-runner"

/**
 * Pluggable reviewer. Phase 2 ships the deterministic, rule-based reviewer.
 * Phase 3+ may swap in an LLM-backed reviewer that calls Sonnet — same
 * interface, so the dispatcher loop never changes.
 */
export interface ContractReviewer {
  readonly name: string
  review(input: ContractReviewerInput): ContractReview
}

export interface ContractReviewerInput {
  contract: AgentContract
  result: AgentResult
  /** Optional: validation command run results captured by the dispatcher. */
  testRuns?: TestRunResult[]
  /** Optional: filesChanged actually observed in the patch.diff (cross-check vs result.filesChanged). */
  observedFilesChanged?: string[]
  /** Whether this is a retry. Affects what nextPrompt looks like. */
  attempt?: number
}

/**
 * Rule-based reviewer: deterministically evaluates each success criterion
 * against the AgentResult + observed evidence.
 *
 * Verdict policy:
 *   - any criterion FAIL on a forbidden-file rule          → rejected (no retry)
 *   - result.status === "blocked"                          → needs_human
 *   - all criteria pass                                    → accepted
 *   - some criteria fail AND attempt < maxRetries          → needs_retry (with nextPrompt)
 *   - some criteria fail AND attempt >= maxRetries         → needs_human
 */
export class RuleBasedContractReviewer implements ContractReviewer {
  readonly name = "rule-based"

  review(input: ContractReviewerInput): ContractReview {
    const { contract, result } = input
    const criteriaResults: CriterionResult[] = contract.successCriteria.map((criterion) =>
      this.evaluateCriterion(criterion, contract, result, input),
    )

    const anyForbiddenFail = criteriaResults.some(
      (c) => c.status === "fail" && /forbiddenfiles/i.test(c.criterion),
    )
    if (anyForbiddenFail) {
      return {
        contractId: contract.contractId,
        verdict: "rejected",
        reasons: ["worker touched a forbidden file; rejecting without retry"],
        criteriaResults,
      }
    }

    if (result.status === "blocked") {
      return {
        contractId: contract.contractId,
        verdict: "needs_human",
        reasons: [`worker reported blocked: ${result.summary || "(no summary)"}`],
        criteriaResults,
      }
    }

    const failed = criteriaResults.filter((c) => c.status === "fail")
    if (failed.length === 0) {
      return {
        contractId: contract.contractId,
        verdict: "accepted",
        reasons: ["all success criteria passed"],
        criteriaResults,
      }
    }

    const attempt = input.attempt ?? 1
    if (attempt < contract.maxRetries + 1) {
      return {
        contractId: contract.contractId,
        verdict: "needs_retry",
        reasons: failed.map((c) => `criterion failed: ${c.criterion}`),
        criteriaResults,
        nextPrompt: buildRefinedPrompt(contract, failed, result),
      }
    }

    return {
      contractId: contract.contractId,
      verdict: "needs_human",
      reasons: [
        `exhausted retries (${attempt}/${contract.maxRetries + 1})`,
        ...failed.map((c) => `criterion failed: ${c.criterion}`),
      ],
      criteriaResults,
    }
  }

  private evaluateCriterion(
    criterion: string,
    contract: AgentContract,
    result: AgentResult,
    ctx: ContractReviewerInput,
  ): CriterionResult {
    const observed = ctx.observedFilesChanged ?? result.filesChanged

    if (/at least one file changed/i.test(criterion)) {
      return observed.length > 0
        ? { criterion, status: "pass", evidence: [`filesChanged=${observed.length}`] }
        : { criterion, status: "fail", evidence: ["no files were changed"] }
    }
    if (/within `?allowedFiles`?/i.test(criterion)) {
      const outOfScope = observed.filter((f) => !contract.allowedFiles.includes(f))
      return outOfScope.length === 0
        ? { criterion, status: "pass", evidence: [`all ${observed.length} file(s) within allowedFiles`] }
        : { criterion, status: "fail", evidence: [`out-of-scope: ${outOfScope.join(", ")}`] }
    }
    if (/within `?forbiddenFiles`?/i.test(criterion)) {
      const violated = observed.filter((f) => contract.forbiddenFiles.includes(f))
      return violated.length === 0
        ? { criterion, status: "pass", evidence: ["no forbidden files touched"] }
        : { criterion, status: "fail", evidence: [`forbidden: ${violated.join(", ")}`] }
    }
    if (/explains the root cause/i.test(criterion)) {
      const len = (result.summary ?? "").trim().length
      return len >= 20
        ? { criterion, status: "pass", evidence: [`summary length=${len}`] }
        : { criterion, status: "fail", evidence: ["summary missing or too short"] }
    }
    if (/validation commands exit zero/i.test(criterion)) {
      const runs = ctx.testRuns ?? []
      if (runs.length === 0) {
        return { criterion, status: "unknown", evidence: ["no validation runs recorded"] }
      }
      const failures = runs.filter((r) => r.exitCode !== 0)
      return failures.length === 0
        ? { criterion, status: "pass", evidence: runs.map((r) => `${r.command} exit=${r.exitCode}`) }
        : { criterion, status: "fail", evidence: failures.map((r) => `${r.command} exit=${r.exitCode}`) }
    }
    if (/policies\/check.+allowed=true/i.test(criterion)) {
      // Dispatcher is responsible for actually re-checking policy. Without
      // that evidence, mark unknown — never silently pass.
      return { criterion, status: "unknown", evidence: ["dispatcher did not supply policy recheck result"] }
    }
    // Default: unknown criterion (e.g. user-supplied). Mark unknown — neither
    // pass nor fail, so it doesn't drive retry/reject by itself.
    return { criterion, status: "unknown", evidence: ["no rule for this criterion in the rule-based reviewer"] }
  }
}

function buildRefinedPrompt(contract: AgentContract, failed: CriterionResult[], result: AgentResult): string {
  const lines: string[] = []
  lines.push(`Your previous attempt for ${contract.contractId} did not satisfy ${failed.length} success criterion(a):`)
  for (const f of failed) {
    lines.push(`- ${f.criterion}`)
    for (const e of f.evidence) lines.push(`  - evidence: ${e}`)
  }
  if (result.unresolvedQuestions.length > 0) {
    lines.push("")
    lines.push("Your unresolved questions from the previous attempt:")
    for (const q of result.unresolvedQuestions) lines.push(`- ${q}`)
  }
  lines.push("")
  lines.push("Retry. Stay within allowedFiles. Do not touch forbiddenFiles. Address each failed criterion above.")
  return lines.join("\n")
}
