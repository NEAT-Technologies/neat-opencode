import type { CommandModule } from "yargs"
import { runPistis } from "./index"

/**
 * Yargs CommandModule for `opencode pistis run`. The opencode package wires
 * this in via its existing `cmd()` registration so we don't depend on the
 * runtime substrate (Effect, InstanceRef) — Phase 1 Pistis is a pure
 * read-only flow.
 *
 * The builder/handler are typed against `any` so the OpenCode CLI can
 * register this CommandModule without inheriting our flag types into its
 * own argv inference (matches how other opencode commands erase their args).
 */
const RunSub: CommandModule<unknown, unknown> = {
  command: "run",
  describe: "run Pistis remediation against a NEAT incident (Phase 1: deterministic dry-run scaffold)",
  builder: (yargs) =>
    yargs
      .option("incident", {
        type: "string",
        demandOption: true,
        describe: "path to a NEAT/Pistis incident JSON file",
      })
      .option("neat-url", {
        type: "string",
        describe: "NEAT Core base URL (defaults to NEAT_CORE_URL or http://localhost:8080)",
      })
      .option("project", {
        type: "string",
        describe: "NEAT project name; when set, project-scoped routes are used",
      })
      .option("test-command", {
        type: "string",
        array: true,
        describe: "validation command (repeatable). Phase 1 records but does not execute.",
      })
      .option("out", {
        type: "string",
        default: ".pistis/runs",
        describe: "artifact root directory",
      })
      .option("dry-run", {
        type: "boolean",
        default: true,
        describe: "Phase 1 default: true. No code changes, no agent execution.",
      })
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "Phase 2+ : dispatch an OpenCode implementation session. Not supported in Phase 1.",
      })
      .option("pr", {
        type: "boolean",
        default: false,
        describe: "Phase 3+ : open a GitHub PR. Not supported in Phase 1.",
      })
      .option("approve-risk", {
        type: "string",
        array: true,
        describe: "explicitly approve a blocked risk gate by id (repeatable)",
      }),
  async handler(args) {
    const a = args as Record<string, unknown>
    try {
      const result = await runPistis({
        incidentPath: String(a.incident),
        neatUrl: typeof a["neat-url"] === "string" ? (a["neat-url"] as string) : undefined,
        project: typeof a.project === "string" ? (a.project as string) : undefined,
        testCommands: Array.isArray(a["test-command"]) ? (a["test-command"] as string[]) : [],
        outDir: typeof a.out === "string" ? (a.out as string) : undefined,
        dryRun: a["dry-run"] !== false,
        apply: a.apply === true,
        pr: a.pr === true,
        approveRisk: Array.isArray(a["approve-risk"]) ? (a["approve-risk"] as string[]) : [],
      })
      process.stdout.write(formatSummary(result) + "\n")
    } catch (err) {
      process.stderr.write(`pistis: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  },
}

export const PistisCommand: CommandModule<unknown, unknown> = {
  command: "pistis",
  describe: "AI remediation execution layer (NEAT bridge)",
  builder: (yargs) => yargs.command(RunSub).demandCommand(),
  async handler() {
    // root pistis command shows help via demandCommand()
  },
}

function formatSummary(r: Awaited<ReturnType<typeof runPistis>>): string {
  const lines = [
    `incident: ${r.incidentId}`,
    `classification: ${r.classification}`,
    `risk: ${r.worstRiskStatus}`,
    `policy: ${r.policyStatus}`,
    `dispatched: ${r.dispatched ? "yes" : "no"}`,
    `run dir: ${r.runDir}`,
    `artifacts: ${r.artifacts.join(", ")}`,
    r.dryRun ? "no code was modified (dry run)." : "",
  ].filter((l) => l.length > 0)
  return lines.join("\n")
}
