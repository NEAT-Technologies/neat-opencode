/**
 * GitHub PR creation — Phase 3 surface.
 *
 * Phase 1 ships only types and a guard so the wiring is in place. Real PR
 * creation arrives in Phase 3 (gh CLI / existing OpenCode GitHub abstractions),
 * and must require explicit `--pr`.
 */

export interface PullRequestRequest {
  incidentId: string
  branchName: string
  title: string
  body: string
  base: string
  draft: boolean
  /** Files that should be staged into the PR commit. Pistis never commits. */
  filesToStage: string[]
}

export interface PullRequestResult {
  url: string
  number: number
  branch: string
}

export interface PullRequestCreator {
  readonly name: string
  create(req: PullRequestRequest): Promise<PullRequestResult>
}

export class PullRequestNotImplementedError extends Error {
  constructor() {
    super("PR creation is a Phase 3 feature and is not implemented yet")
    this.name = "PullRequestNotImplementedError"
  }
}

/** Phase 1 placeholder — used to assert no caller bypassed the phase gate. */
export class DisabledPullRequestCreator implements PullRequestCreator {
  readonly name = "disabled"
  async create(): Promise<PullRequestResult> {
    throw new PullRequestNotImplementedError()
  }
}
