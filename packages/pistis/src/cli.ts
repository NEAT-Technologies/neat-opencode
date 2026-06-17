import type { CommandModule } from "yargs"
import { runPistis } from "./index"
import type { WorkerKind } from "./index"
import { PistisDaemon } from "./daemon"

/**
 * `opencode pistis run` — the bridge command.
 *
 * Phase 1 (default): dry-run, deterministic scaffold.
 * Phase 2 (--apply): runs one worker per AgentContract, captures patch.diff
 *                    and test-report.txt, reviews against successCriteria,
 *                    retries up to --max-retries with a refined prompt.
 */
const RunSub: CommandModule<unknown, unknown> = {
  command: "run",
  describe: "run Pistis remediation against a NEAT incident",
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
        describe: "validation command (repeatable). Phase 2 sandbox-executes via /bin/sh -c.",
      })
      .option("out", {
        type: "string",
        default: ".pistis/runs",
        describe: "artifact root directory",
      })
      .option("dry-run", {
        type: "boolean",
        default: true,
        describe: "default true. --apply turns this off and runs the worker.",
      })
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "Phase 2: dispatch a worker (per AgentContract) and capture patch.diff + contract-review.json.",
      })
      .option("pr", {
        type: "boolean",
        default: false,
        describe: "Phase 4: open a GitHub PR. Not supported yet.",
      })
      .option("approve-risk", {
        type: "string",
        array: true,
        describe: "explicitly approve a blocked risk gate by id (repeatable)",
      })
      .option("worker", {
        type: "string",
        choices: ["stub", "opencode", "multi-role-stub"],
        default: "stub",
        describe: "Worker. `stub`/`opencode` for Phase 2 single-contract; `multi-role-stub` for Phase 3 orchestration.",
      })
      .option("multi-agent", {
        type: "boolean",
        default: false,
        describe: "Phase 3: orchestrate multiple agent roles (graph_context, root_cause, patch, test, reviewer, security_risk, migration).",
      })
      .option("workspace", {
        type: "string",
        describe: "Phase 2 host path the worker operates in. MUST be a clean git repo unless --allow-dirty-workspace/--allow-non-git-workspace.",
      })
      .option("max-retries", {
        type: "number",
        default: 2,
        describe: "cap on contract retries (so 3 attempts total at default)",
      })
      .option("allow-dirty-workspace", {
        type: "boolean",
        default: false,
        describe: "let the worker run even if --workspace has uncommitted changes",
      })
      .option("allow-non-git-workspace", {
        type: "boolean",
        default: false,
        describe: "let the worker run on a non-git directory (diff capture degrades)",
      })
      .option("use-router", {
        type: "boolean",
        default: false,
        describe: "Phase 4D: use the real model stack — FlashWorker (reasoning) + MinimaxWorker (patch/migration), composed via RouterWorker. Requires GEMINI_API_KEY and MINIMAX_API_KEY in the environment.",
      })
      .option("use-kimi-reviewer", {
        type: "boolean",
        default: false,
        describe: "Phase 4D: use KimiReviewer (Moonshot K2.7) with the 8 read-only NEAT tools for file-writing role review. Requires MOONSHOT_API_KEY.",
      })
      .option("max-tool-calls", {
        type: "number",
        describe: "Phase 4D: override KimiReviewer iteration cap (default 8, clamped to [1, 16]). Also respects PISTIS_KIMI_TOOL_BUDGET.",
      }),
  async handler(args) {
    const a = args as Record<string, unknown>
    try {
      const worker = (typeof a.worker === "string" ? a.worker : "stub") as WorkerKind
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
        worker,
        workspace: typeof a.workspace === "string" ? (a.workspace as string) : undefined,
        maxRetries: typeof a["max-retries"] === "number" ? (a["max-retries"] as number) : undefined,
        allowDirtyWorkspace: a["allow-dirty-workspace"] === true,
        allowNonGitWorkspace: a["allow-non-git-workspace"] === true,
        multiAgent: a["multi-agent"] === true,
        useRouter: a["use-router"] === true,
        useKimiReviewer: a["use-kimi-reviewer"] === true,
        maxToolCalls: typeof a["max-tool-calls"] === "number" ? (a["max-tool-calls"] as number) : undefined,
      })
      process.stdout.write(formatSummary(result) + "\n")
    } catch (err) {
      process.stderr.write(`pistis: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  },
}

const DaemonSub: CommandModule<unknown, unknown> = {
  command: "daemon",
  describe: "Phase 5A: run Pistis as a long-lived HTTP server (NEAT-callable)",
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number",
        default: 7777,
        describe: "TCP port to bind to (default 7777)",
      })
      .option("hostname", {
        type: "string",
        default: "127.0.0.1",
        describe: "bind hostname (default 127.0.0.1 — do NOT expose to the public internet)",
      })
      .option("webhook-url", {
        type: "string",
        describe: "POST result.json to this URL on every run completion. Requires PISTIS_WEBHOOK_SECRET in env.",
      })
      .option("cors-origin", {
        type: "string",
        describe: "enable CORS for this exact origin (e.g. https://neat.local). Omit for server-to-server use.",
      })
      .option("use-router", {
        type: "boolean",
        default: false,
        describe: "use Flash+MiniMax via RouterWorker for every run (Phase 4D defaults).",
      })
      .option("use-kimi-reviewer", {
        type: "boolean",
        default: false,
        describe: "use KimiReviewer for every run (Phase 4D defaults).",
      })
      .option("max-retries", {
        type: "number",
        default: 2,
      }),
  async handler(args) {
    const a = args as Record<string, unknown>
    const token = process.env.PISTIS_TOKEN ?? ""
    if (token.length === 0) {
      process.stderr.write("pistis: PISTIS_TOKEN env var is required to start the daemon\n")
      process.exitCode = 1
      return
    }
    const webhookUrl = typeof a["webhook-url"] === "string" ? (a["webhook-url"] as string) : undefined
    let webhook
    if (webhookUrl && webhookUrl.length > 0) {
      const secret = process.env.PISTIS_WEBHOOK_SECRET ?? ""
      if (secret.length === 0) {
        process.stderr.write("pistis: --webhook-url requires PISTIS_WEBHOOK_SECRET env var\n")
        process.exitCode = 1
        return
      }
      webhook = { url: webhookUrl, secret }
    }
    const daemon = new PistisDaemon({
      port: typeof a.port === "number" ? (a.port as number) : 7777,
      hostname: typeof a.hostname === "string" ? (a.hostname as string) : "127.0.0.1",
      token,
      webhook,
      corsOrigin: typeof a["cors-origin"] === "string" ? (a["cors-origin"] as string) : undefined,
      defaultConfig: {
        multiAgent: true,
        apply: true,
        useRouter: a["use-router"] === true,
        useKimiReviewer: a["use-kimi-reviewer"] === true,
        maxRetries: typeof a["max-retries"] === "number" ? (a["max-retries"] as number) : 2,
      },
    })
    const info = daemon.start()
    process.stdout.write(`pistis daemon listening on ${info.url}\n`)

    const shutdown = async () => {
      process.stdout.write("\npistis daemon: shutting down gracefully...\n")
      await daemon.stop()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  },
}

export const PistisCommand: CommandModule<unknown, unknown> = {
  command: "pistis",
  describe: "AI remediation execution layer (NEAT bridge)",
  builder: (yargs) => yargs.command(RunSub).command(DaemonSub).demandCommand(),
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
    r.dispatchReason ? `dispatch reason: ${r.dispatchReason}` : "",
    `run dir: ${r.runDir}`,
    `artifacts: ${r.artifacts.join(", ")}`,
    r.dryRun ? "no code was modified (dry run)." : "",
  ].filter((l) => l.length > 0)
  return lines.join("\n")
}
