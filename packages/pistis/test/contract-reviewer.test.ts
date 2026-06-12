import { describe, expect, test } from "bun:test"
import { RuleBasedContractReviewer } from "../src/contract/reviewer"
import type { AgentContract, AgentResult } from "../src/contract/types"
import type { TestRunResult } from "../src/validation/test-runner"

function contract(overrides: Partial<AgentContract> = {}): AgentContract {
  return {
    contractId: "INC-X::patch::001",
    agentRole: "patch",
    objective: "fix the bug",
    graphContext: {},
    allowedFiles: ["src/a.ts"],
    forbiddenFiles: [".env"],
    constraints: ["only allowedFiles"],
    successCriteria: [
      "Produce a unified diff in `patch.diff` with at least one file changed.",
      "All files in the diff are within `allowedFiles`.",
      "No files in the diff are within `forbiddenFiles`.",
      "AgentResult.summary explains the root cause and the change.",
    ],
    requiredOutputs: ["patch.diff"],
    validationCommands: [],
    maxRetries: 2,
    ...overrides,
  }
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    contractId: "INC-X::patch::001",
    status: "completed",
    summary: "fixed a null deref in handler; root cause was missing nullcheck before access",
    filesChanged: ["src/a.ts"],
    testsRun: [],
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    riskNotes: [],
    unresolvedQuestions: [],
    ...overrides,
  }
}

describe("RuleBasedContractReviewer", () => {
  const r = new RuleBasedContractReviewer()

  test("accepts when all rule-based criteria pass", () => {
    const review = r.review({ contract: contract(), result: result(), attempt: 1 })
    expect(review.verdict).toBe("accepted")
    expect(review.criteriaResults.every((c) => c.status === "pass" || c.status === "unknown")).toBe(true)
  })

  test("rejects (no retry) when worker touched a forbidden file", () => {
    const review = r.review({
      contract: contract(),
      result: result({ filesChanged: ["src/a.ts", ".env"] }),
      observedFilesChanged: ["src/a.ts", ".env"],
      attempt: 1,
    })
    expect(review.verdict).toBe("rejected")
    expect(review.nextPrompt).toBeUndefined()
  })

  test("needs_retry when criterion fails and attempts remain", () => {
    const review = r.review({
      contract: contract({ successCriteria: ["Produce a unified diff in `patch.diff` with at least one file changed."], maxRetries: 2 }),
      result: result({ filesChanged: [] }),
      observedFilesChanged: [],
      attempt: 1,
    })
    expect(review.verdict).toBe("needs_retry")
    expect(review.nextPrompt).toBeDefined()
    expect(review.nextPrompt!).toContain("at least one file changed")
  })

  test("needs_human when retries exhausted", () => {
    const review = r.review({
      contract: contract({ successCriteria: ["Produce a unified diff in `patch.diff` with at least one file changed."], maxRetries: 0 }),
      result: result({ filesChanged: [] }),
      observedFilesChanged: [],
      attempt: 1,
    })
    expect(review.verdict).toBe("needs_human")
  })

  test("needs_human when result.status is blocked", () => {
    const review = r.review({
      contract: contract(),
      result: result({ status: "blocked", summary: "external dep down" }),
      attempt: 1,
    })
    expect(review.verdict).toBe("needs_human")
  })

  test("validation criterion uses testRuns evidence", () => {
    const runs: TestRunResult[] = [
      { command: "jest", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10, deferred: false, timedOut: false },
    ]
    const c = contract({
      successCriteria: [
        "All validation commands exit zero: `jest`.",
      ],
      validationCommands: ["jest"],
    })
    const review = r.review({ contract: c, result: result({ filesChanged: ["src/a.ts"] }), testRuns: runs, attempt: 1 })
    expect(review.verdict).toBe("accepted")
  })

  test("validation criterion fails when a test exits nonzero", () => {
    const runs: TestRunResult[] = [
      { command: "jest", exitCode: 1, stdout: "fail", stderr: "", durationMs: 10, deferred: false, timedOut: false },
    ]
    const c = contract({
      successCriteria: ["All validation commands exit zero: `jest`."],
      validationCommands: ["jest"],
      maxRetries: 1,
    })
    const review = r.review({ contract: c, result: result(), testRuns: runs, attempt: 1 })
    expect(review.verdict).toBe("needs_retry")
  })
})
