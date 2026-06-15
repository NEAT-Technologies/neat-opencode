import { promises as fs } from "node:fs"
import { join, resolve, relative } from "node:path"
import type { Worker, WorkerWorkspace } from "../opencode/worker"
import type { AgentContract, AgentResult } from "../contract/types"
import type { AgentRole } from "./roles"

/**
 * Multi-role stub worker. Dispatches by `contract.agentRole` to a deterministic
 * per-role behavior. This is the Phase 3 default `--worker` for orchestration;
 * the real OpenCode-backed multi-role worker comes later (one worker class per
 * role, each with its own system prompt and tools).
 *
 * Behaviour by role:
 *
 *  graph_context  : reads priorFindings (none), summarizes the contract's
 *                   embedded graphContext into a 4-sentence finding.
 *  root_cause     : reads priorFindings.graph_context, proposes a root cause
 *                   hypothesis based on the incident message + graph state.
 *  patch          : reuses the existing StubWorker behaviour (touch allowed
 *                   files; PISTIS_NOTE comment); references priorFindings.
 *  test           : runs nothing itself — orchestrator's runTestCommands does
 *                   the actual execution. The role's AgentResult declares the
 *                   commands it expected to be run; the dispatcher attaches
 *                   the actual results.
 *  reviewer       : reads priorFindings.patch and priorFindings.test and
 *                   produces an accept/reject summary.
 *  security_risk  : scans the patch's filesChanged for surface-level risky
 *                   names (e.g. files containing "auth", "secret", "token").
 *  migration      : writes a placeholder SQL file under migrations/ inside
 *                   the workspace.
 */
export class MultiRoleStubWorker implements Worker {
  readonly name = "multi-role-stub"

  async run(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
    const role = contract.agentRole as AgentRole
    const prior = contract.inputs?.priorFindings ?? {}
    switch (role) {
      case "graph_context":    return graphContextRole(contract)
      case "root_cause":       return rootCauseRole(contract, prior)
      case "patch":            return patchRole(contract, workspace)
      case "test":             return testRole(contract)
      case "reviewer":         return reviewerRole(contract, prior)
      case "security_risk":    return securityRiskRole(contract, prior)
      case "migration":        return migrationRole(contract, workspace)
    }
    return {
      contractId: contract.contractId,
      status: "failed",
      summary: `unknown role: ${role}`,
      filesChanged: [],
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: [`worker has no handler for role=${role}`],
    }
  }
}

function graphContextRole(contract: AgentContract): AgentResult {
  const g = contract.graphContext as { neat?: { baseUrl?: string }; primaryNode?: { id?: string } } | undefined
  const node = g?.primaryNode?.id ?? "(unknown)"
  const summary =
    `Primary node is ${node}. Graph context fetched from NEAT and packaged with edges, root-cause hints, blast radius, ` +
    `dependencies, divergences, and policy violations where each section was available. ` +
    `Unavailable sections are recorded explicitly in graph-context.json so downstream agents can reason about gaps. ` +
    `This summary is deterministic in Phase 3; LLM-backed summarization replaces it later.`
  return {
    contractId: contract.contractId,
    status: "completed",
    summary,
    filesChanged: [],
    testsRun: [],
    riskNotes: [],
    unresolvedQuestions: [],
  }
}

function rootCauseRole(
  contract: AgentContract,
  prior: Record<string, AgentResult>,
): AgentResult {
  const ctxSummary = prior.graph_context?.summary ?? "(graph_context findings missing)"
  const summary =
    `Working hypothesis: based on the graph context (${ctxSummary.slice(0, 120)}...), the most likely root ` +
    `cause is a defect in the primary node or one of its inbound edges. Deterministic Phase 3 stub does not ` +
    `reason further; the LLM-backed root-cause agent in a follow-up will refine this hypothesis.`
  return {
    contractId: contract.contractId,
    status: "completed",
    summary,
    filesChanged: [],
    testsRun: [],
    riskNotes: [],
    unresolvedQuestions: ["which specific edge introduced the defect?", "is there a related divergence?"],
  }
}

async function patchRole(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
  const filesChanged: string[] = []
  for (const allowed of contract.allowedFiles) {
    if (contract.forbiddenFiles.includes(allowed)) continue
    const abs = safeResolve(workspace.cwd, allowed)
    if (!abs) continue
    const exists = await fileExists(abs)
    if (!exists) continue
    const content = await fs.readFile(abs, "utf8").catch(() => "")
    const stamped = content + (content.endsWith("\n") || content === "" ? "" : "\n") +
      `\n// PISTIS_NOTE (${contract.contractId}): considered for remediation\n`
    await fs.writeFile(abs, stamped, "utf8")
    filesChanged.push(allowed)
  }
  if (filesChanged.length === 0) {
    const fixPath = "PISTIS_PROPOSED_FIX.md"
    const abs = safeResolve(workspace.cwd, fixPath)
    if (abs) {
      await fs.writeFile(abs, `# Proposed fix (multi-role stub)\n\nContract: ${contract.contractId}\n`, "utf8")
      filesChanged.push(fixPath)
    }
  }
  return {
    contractId: contract.contractId,
    status: "completed",
    summary: `Patch role stub touched ${filesChanged.length} file(s) in ${workspace.cwd}.`,
    filesChanged: [...new Set(filesChanged)].sort(),
    testsRun: [],
    riskNotes: [],
    unresolvedQuestions: [],
  }
}

function testRole(contract: AgentContract): AgentResult {
  return {
    contractId: contract.contractId,
    status: "completed",
    summary: `Test role declared ${contract.validationCommands.length} command(s) for the orchestrator to run.`,
    filesChanged: [],
    testsRun: [...contract.validationCommands],
    riskNotes: [],
    unresolvedQuestions: [],
  }
}

function reviewerRole(
  contract: AgentContract,
  prior: Record<string, AgentResult>,
): AgentResult {
  const patch = prior.patch ?? prior.migration
  const test = prior.test
  const filesChanged = patch?.filesChanged ?? []
  const verdict =
    patch && filesChanged.length > 0
      ? "accept — patch produced a non-empty diff"
      : "reject — no files were changed"
  const testsExitedZero = test ? test.testsRun.length : 0
  return {
    contractId: contract.contractId,
    status: "completed",
    summary:
      `Reviewer recommendation: ${verdict}. ${filesChanged.length} file(s) modified by upstream patch/migration; ` +
      `${testsExitedZero} test command(s) declared by test role.`,
    filesChanged: [],
    testsRun: [],
    riskNotes: [],
    unresolvedQuestions: [],
  }
}

function securityRiskRole(
  contract: AgentContract,
  prior: Record<string, AgentResult>,
): AgentResult {
  const patchFiles = prior.patch?.filesChanged ?? []
  const risky = patchFiles.filter((f) =>
    /(auth|session|jwt|oauth|secret|token|password|credential)/i.test(f),
  )
  return {
    contractId: contract.contractId,
    status: "completed",
    summary:
      risky.length === 0
        ? `Security/risk scan: no obviously-sensitive paths in the ${patchFiles.length} patched file(s).`
        : `Security/risk scan: ${risky.length} sensitive path(s) touched by the patch; human review recommended.`,
    filesChanged: [],
    testsRun: [],
    riskNotes: risky.map((f) => `sensitive path touched: ${f}`),
    unresolvedQuestions: [],
  }
}

async function migrationRole(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
  // Write a placeholder migration file. Real migration agent would generate SQL.
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)
  const name = `migrations/${ts}_${contract.contractId.replace(/[^A-Za-z0-9_-]+/g, "_")}.sql`
  const abs = safeResolve(workspace.cwd, name)
  if (!abs) {
    return {
      contractId: contract.contractId,
      status: "failed",
      summary: "migration role could not resolve a safe migration path",
      filesChanged: [],
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: ["workspace path resolution failed"],
    }
  }
  await fs.mkdir(join(workspace.cwd, "migrations"), { recursive: true })
  await fs.writeFile(
    abs,
    `-- PISTIS draft migration\n-- contract: ${contract.contractId}\n-- DO NOT RUN: review and edit before applying.\n\n-- BEGIN;\n-- TODO: real schema changes\n-- COMMIT;\n`,
    "utf8",
  )
  return {
    contractId: contract.contractId,
    status: "completed",
    summary: `Migration role drafted ${name}. Not executed.`,
    filesChanged: [name],
    testsRun: [],
    riskNotes: ["migration drafted but not executed; requires human approval"],
    unresolvedQuestions: [],
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
