/**
 * Thrown by a Worker when asked to handle a role outside its competence.
 * The orchestrator (or a router worker) catches this and routes the role
 * to a different Worker.
 */
export class OutOfRoleError extends Error {
  override readonly name = "OutOfRoleError"
  constructor(
    readonly attemptedRole: string,
    readonly worker: string,
  ) {
    super(`${worker} does not handle role: ${attemptedRole}`)
  }
}
