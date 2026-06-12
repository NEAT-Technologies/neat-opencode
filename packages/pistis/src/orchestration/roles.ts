/**
 * Pistis agent roles per the contract-driven prompt.
 *
 * These map directly to the seven roles the contract names for Phase 3:
 *   - graph_context, root_cause, patch, test, reviewer, security_risk, migration
 *
 * The orchestrator picks a subset per issue class. Each role has its own
 * contract shape (allowedFiles, successCriteria, etc.) — see
 * `role-contract-builders.ts`.
 */
export type AgentRole =
  | "graph_context"
  | "root_cause"
  | "patch"
  | "test"
  | "reviewer"
  | "security_risk"
  | "migration"

/**
 * Roles that are allowed to write files in the workspace. All other roles
 * are reasoning agents and must return their findings only via AgentResult.
 */
export const FILE_WRITING_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["patch", "migration"])
