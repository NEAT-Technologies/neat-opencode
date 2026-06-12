import type { AgentRole } from "./roles"
import type { Classification, IssueClass } from "../planner/classifier"

/**
 * One step in the orchestration plan. `dependsOn` is informational for the
 * artifact rendering; the Phase 3 MVP dispatches sequentially in order, so
 * "depends" is implied. Future parallel dispatch will key off this field.
 */
export interface OrchestrationStep {
  role: AgentRole
  dependsOn: AgentRole[]
}

export interface OrchestrationPlan {
  steps: OrchestrationStep[]
  reasoning: string
}

/**
 * Pick a role sequence based on the deterministic classifier. The contract's
 * "Sonnet decides which workers to use" can be model-driven later — this
 * planner is the deterministic fallback and the testable seed.
 *
 * Defaults:
 *   - All classes start with `graph_context` → `root_cause`.
 *   - Code-fix classes (runtime_exception, http_5xx, dependency_failure,
 *     missing_instrumentation, stale_edge, divergence): + patch + test
 *   - policy_violation: + patch + security_risk + test
 *   - db_schema_or_query: + migration + test (no patch — migration role owns
 *     schema changes)
 *   - unknown: graph_context + root_cause only; orchestrator escalates rather
 *     than dispatching speculative patch
 *
 * All classes end with `reviewer` and (for code-fix classes) `security_risk`.
 */
export function buildOrchestrationPlan(classification: Classification): OrchestrationPlan {
  const cls: IssueClass = classification.class
  const steps: OrchestrationStep[] = []

  steps.push({ role: "graph_context", dependsOn: [] })
  steps.push({ role: "root_cause", dependsOn: ["graph_context"] })

  if (cls === "db_schema_or_query") {
    steps.push({ role: "migration", dependsOn: ["root_cause"] })
    steps.push({ role: "test", dependsOn: ["migration"] })
    steps.push({ role: "security_risk", dependsOn: ["migration"] })
    steps.push({ role: "reviewer", dependsOn: ["migration", "test", "security_risk"] })
    return { steps, reasoning: "db_schema_or_query: migration owns schema; no patch role." }
  }

  if (cls === "policy_violation") {
    steps.push({ role: "patch", dependsOn: ["root_cause"] })
    steps.push({ role: "security_risk", dependsOn: ["patch"] })
    steps.push({ role: "test", dependsOn: ["patch"] })
    steps.push({ role: "reviewer", dependsOn: ["patch", "security_risk", "test"] })
    return { steps, reasoning: "policy_violation: security_risk runs before tests to catch unsafe widening." }
  }

  if (cls === "unknown") {
    steps.push({ role: "reviewer", dependsOn: ["root_cause"] })
    return { steps, reasoning: "unknown class: investigate-only, no speculative patch. Reviewer decides escalation." }
  }

  steps.push({ role: "patch", dependsOn: ["root_cause"] })
  steps.push({ role: "test", dependsOn: ["patch"] })
  steps.push({ role: "security_risk", dependsOn: ["patch"] })
  steps.push({ role: "reviewer", dependsOn: ["patch", "test", "security_risk"] })
  return { steps, reasoning: `${cls}: standard code-fix sequence (graph→root_cause→patch→test→security_risk→reviewer).` }
}
