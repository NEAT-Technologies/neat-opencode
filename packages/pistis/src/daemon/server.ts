import { promises as fs } from "node:fs"
import { join } from "node:path"
import { isAuthorized } from "./auth"
import { RunRegistry, type RunRecord, type RunStatus } from "./run-registry"
import { validateArtifactPath, contentTypeFor } from "./artifact-path"
import { deliverWebhook, type WebhookConfig } from "./webhook"
import { buildResult, summariseToolCalls, type ResultSinkInput } from "./result-sink"
import { runPistis, type RunPistisOptions, type RunPistisResult } from "../index"
import packageJson from "../../package.json"

const DEFAULT_MAX_RUN_BODY_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_CANCEL_BODY_BYTES = 4 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

export interface PistisDaemonOptions {
  port: number
  hostname?: string
  token: string
  webhook?: WebhookConfig
  /** Default config merged into per-run config when not specified. */
  defaultConfig?: Partial<RunPistisOptions>
  corsOrigin?: string
  maxRunBodyBytes?: number
  maxCancelBodyBytes?: number
  maxArtifactBytes?: number
  shutdownTimeoutMs?: number
  runRegistry?: RunRegistry
  /** Injected for tests — the function actually used to run an orchestration. */
  runImpl?: (opts: RunPistisOptions) => Promise<RunPistisResult>
  /** Process.hrtime / Date.now for uptime calc — replaceable for tests. */
  now?: () => number
}

export class PistisDaemon {
  private readonly opts: PistisDaemonOptions
  private readonly registry: RunRegistry
  private readonly token: string
  private readonly startedAt: number
  private server: ReturnType<typeof Bun.serve> | null = null
  private inflight = 0

  constructor(opts: PistisDaemonOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new Error("PistisDaemon: token is required")
    }
    if (opts.webhook && (!opts.webhook.secret || opts.webhook.secret.length === 0)) {
      throw new Error("PistisDaemon: webhook.secret is required when webhook.url is set")
    }
    this.opts = opts
    this.token = opts.token
    this.registry = opts.runRegistry ?? new RunRegistry()
    this.startedAt = (opts.now ?? Date.now)()
  }

  start(): { url: string; port: number; hostname: string } {
    const server = Bun.serve({
      port: this.opts.port,
      hostname: this.opts.hostname ?? "127.0.0.1",
      fetch: (req) => this.handle(req),
    })
    this.server = server
    const port = server.port ?? this.opts.port
    const hostname = server.hostname ?? this.opts.hostname ?? "127.0.0.1"
    return {
      url: `http://${hostname}:${port}`,
      port,
      hostname,
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.stop(false)
    const deadline = Date.now() + (this.opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    this.server = null
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const cors = this.opts.corsOrigin
    if (req.method === "OPTIONS") {
      if (!cors) return new Response(null, { status: 405 })
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": cors,
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST",
        },
      })
    }

    const baseHeaders: Record<string, string> = cors ? { "Access-Control-Allow-Origin": cors } : {}

    if (url.pathname === "/health" && req.method === "GET") {
      return this.respond(200, {
        ok: true,
        version: (packageJson as { version: string }).version,
        uptimeSeconds: Math.floor(((this.opts.now ?? Date.now)() - this.startedAt) / 1000),
      }, baseHeaders)
    }

    if (!isAuthorized(this.token, req)) {
      return this.respond(401, { error: "unauthorized" }, baseHeaders)
    }

    if (url.pathname === "/capabilities" && req.method === "GET") {
      const d = this.opts.defaultConfig ?? {}
      return this.respond(200, {
        features: {
          router: d.useRouter === true,
          kimiReviewer: d.useKimiReviewer === true,
          multiAgent: d.multiAgent !== false,
        },
        version: (packageJson as { version: string }).version,
      }, baseHeaders)
    }

    if (url.pathname === "/schema/incident" && req.method === "GET") {
      const schemaPath = join(import.meta.dir, "..", "..", "schemas", "incident.schema.json")
      try {
        const schema = await fs.readFile(schemaPath, "utf8")
        return new Response(schema, {
          status: 200,
          headers: { "Content-Type": "application/schema+json", ...baseHeaders },
        })
      } catch {
        return this.respond(500, { error: "schema file unavailable" }, baseHeaders)
      }
    }

    if (url.pathname === "/runs" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100")
      const statusFilter = url.searchParams.get("status") as RunStatus | null
      const list = this.registry.list({
        limit: Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100,
        status: statusFilter ?? undefined,
      })
      return this.respond(200, { runs: list }, baseHeaders)
    }

    if (url.pathname === "/run" && req.method === "POST") {
      return this.handleRun(req, baseHeaders)
    }

    const runIdMatch = url.pathname.match(/^\/runs\/([^/]+)(?:\/(.*))?$/)
    if (runIdMatch) {
      const runId = decodeURIComponent(runIdMatch[1])
      const subPath = runIdMatch[2]
      if (!subPath) {
        if (req.method !== "GET") return this.respond(405, { error: "method not allowed" }, baseHeaders)
        const record = this.registry.get(runId)
        if (!record) return this.respond(404, { error: "run not found" }, baseHeaders)
        return this.respond(200, this.formatRunRecord(record), baseHeaders)
      }
      if (subPath === "cancel" && req.method === "POST") {
        return this.handleCancel(req, runId, baseHeaders)
      }
      if (subPath === "artifacts" && req.method === "GET") {
        const record = this.registry.get(runId)
        if (!record) return this.respond(404, { error: "run not found" }, baseHeaders)
        return this.respond(200, { artifacts: record.artifacts }, baseHeaders)
      }
      const artifactsMatch = subPath.match(/^artifacts\/(.+)$/)
      if (artifactsMatch && req.method === "GET") {
        return this.handleArtifactFetch(runId, artifactsMatch[1], baseHeaders)
      }
    }

    return this.respond(404, { error: "not found" }, baseHeaders)
  }

  private async handleRun(req: Request, baseHeaders: Record<string, string>): Promise<Response> {
    const contentType = req.headers.get("content-type") ?? ""
    if (!/application\/json/i.test(contentType)) {
      return this.respond(415, { error: "Content-Type must be application/json" }, baseHeaders)
    }
    const maxBytes = this.opts.maxRunBodyBytes ?? DEFAULT_MAX_RUN_BODY_BYTES
    const bodyText = await readBodyCapped(req, maxBytes)
    if (bodyText.tooLarge) {
      return this.respond(413, { error: "request body exceeds limit" }, baseHeaders)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText.text)
    } catch {
      return this.respond(400, { error: "invalid JSON body" }, baseHeaders)
    }
    if (typeof parsed !== "object" || parsed === null) {
      return this.respond(400, { error: "body must be a JSON object" }, baseHeaders)
    }
    const payload = parsed as { incident?: unknown; config?: Record<string, unknown> }
    if (typeof payload.incident !== "object" || payload.incident === null) {
      return this.respond(400, { error: "missing incident object" }, baseHeaders)
    }
    const cfg = (payload.config ?? {}) as Record<string, unknown>

    if (typeof cfg.workspace === "string" && cfg.workspace.length > 0) {
      const workspaceCheck = await validateWorkspace(
        cfg.workspace,
        cfg.allowNonGitWorkspace === true,
      )
      if (!workspaceCheck.ok) {
        return this.respond(400, { error: workspaceCheck.error }, baseHeaders)
      }
    }

    const incident = payload.incident as { incidentId?: string; id?: string }
    const incidentId = String(incident.incidentId ?? incident.id ?? "unknown-incident")
    const runId = `${incidentId}-${nowSlug()}`
    this.registry.start(runId, incidentId)
    this.registry.setStatus(runId, "running")

    const baseConfig = this.opts.defaultConfig ?? {}
    const runOptions: RunPistisOptions = {
      ...baseConfig,
      ...stripUnknown(cfg),
      incidentPath: "",
      apply: cfg.apply === undefined ? baseConfig.apply : Boolean(cfg.apply),
      multiAgent: cfg.multiAgent === undefined ? baseConfig.multiAgent : Boolean(cfg.multiAgent),
    }

    this.inflight++
    void this.runInBackground(runId, incidentId, payload.incident, runOptions)

    return this.respond(202, {
      runId,
      status: "queued",
      links: {
        self: `/runs/${encodeURIComponent(runId)}`,
        artifacts: `/runs/${encodeURIComponent(runId)}/artifacts`,
      },
    }, baseHeaders)
  }

  private async runInBackground(
    runId: string,
    incidentId: string,
    incidentJson: unknown,
    options: RunPistisOptions,
  ): Promise<void> {
    try {
      const incidentFile = await writeTempIncidentFile(incidentJson, runId)
      const runImpl = this.opts.runImpl ?? runPistis
      const result = await runImpl({ ...options, incidentPath: incidentFile })
      const startRec = this.registry.get(runId)
      this.registry.setStatus(runId, startRec?.status === "cancelled" ? "cancelled" : "completed", {
        verdict: mapDispatchedToVerdict(result),
        classification: result.classification,
        workspaceCwd: options.workspace,
        runDir: result.runDir,
        artifacts: result.artifacts,
      })

      const sinkInput = await this.buildSinkInput(runId, incidentId, result)
      try {
        await fs.writeFile(join(result.runDir, "result.json"), buildResult(sinkInput), "utf8")
      } catch {
        // best-effort; the run still succeeded
      }

      if (this.opts.webhook) {
        const delivery = await deliverWebhook(this.opts.webhook, runId, buildResult(sinkInput))
        if (!delivery.ok) {
          // Logged once. NEAT polls /runs/:id as fallback.
          console.warn(`pistis: webhook delivery failed for runId=${runId}: ${delivery.error}`)
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.registry.setStatus(runId, "failed", { error: this.redactToken(errMessage) })
    } finally {
      this.inflight--
    }
  }

  private async buildSinkInput(
    runId: string,
    incidentId: string,
    result: RunPistisResult,
  ): Promise<ResultSinkInput> {
    let toolCallsText: string | undefined
    try {
      toolCallsText = await fs.readFile(join(result.runDir, "tool-calls.jsonl"), "utf8")
    } catch { /* no kimi run */ }
    let diff: string | undefined
    try {
      diff = await fs.readFile(join(result.runDir, "patch.diff"), "utf8")
    } catch { /* no diff produced */ }
    const startRec = this.registry.get(runId)
    return {
      runId,
      incidentId,
      verdict: startRec?.verdict ?? null,
      classification: result.classification,
      startedAt: startRec?.startedAt ?? new Date().toISOString(),
      finishedAt: startRec?.finishedAt ?? new Date().toISOString(),
      filesChanged: [],
      diff,
      riskNotes: [],
      reviewerName: undefined,
      workerName: undefined,
      toolCallSummary: summariseToolCalls(toolCallsText),
      artifacts: result.artifacts,
    }
  }

  private async handleCancel(req: Request, runId: string, baseHeaders: Record<string, string>): Promise<Response> {
    const maxBytes = this.opts.maxCancelBodyBytes ?? DEFAULT_MAX_CANCEL_BODY_BYTES
    const bodyText = await readBodyCapped(req, maxBytes)
    if (bodyText.tooLarge) {
      return this.respond(413, { error: "request body exceeds limit" }, baseHeaders)
    }
    const outcome = this.registry.cancel(runId)
    if (outcome === "not_found") return this.respond(404, { error: "run not found" }, baseHeaders)
    if (outcome === "already_finished") return this.respond(409, { error: "run already finished" }, baseHeaders)
    return this.respond(200, { ok: true, status: "cancelling" }, baseHeaders)
  }

  private async handleArtifactFetch(
    runId: string,
    rawName: string,
    baseHeaders: Record<string, string>,
  ): Promise<Response> {
    const name = validateArtifactPath(rawName)
    if (!name) {
      return this.respond(400, { error: "path traversal not allowed" }, baseHeaders)
    }
    const record = this.registry.get(runId)
    if (!record || !record.runDir) {
      return this.respond(404, { error: "run not found or no artifacts" }, baseHeaders)
    }
    const filePath = join(record.runDir, name)
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      return this.respond(404, { error: "artifact not found" }, baseHeaders)
    }
    const maxBytes = this.opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    if (stat.size > maxBytes) {
      return this.respond(413, { error: `artifact exceeds limit (${stat.size} > ${maxBytes})` }, baseHeaders)
    }
    const buffer = await fs.readFile(filePath)
    return new Response(buffer, {
      status: 200,
      headers: { "Content-Type": contentTypeFor(name), "Content-Length": String(buffer.length), ...baseHeaders },
    })
  }

  private formatRunRecord(record: RunRecord) {
    return {
      runId: record.runId,
      incidentId: record.incidentId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      verdict: record.verdict ?? null,
      classification: record.classification ?? null,
      artifacts: record.artifacts,
      finalReportUrl: record.artifacts.includes("final-report.md")
        ? `/runs/${encodeURIComponent(record.runId)}/artifacts/final-report.md`
        : null,
      diffUrl: record.artifacts.includes("patch.diff")
        ? `/runs/${encodeURIComponent(record.runId)}/artifacts/patch.diff`
        : null,
      resultUrl: record.artifacts.includes("result.json")
        ? `/runs/${encodeURIComponent(record.runId)}/artifacts/result.json`
        : null,
      error: record.error ?? null,
      links: {
        self: `/runs/${encodeURIComponent(record.runId)}`,
        cancel: `/runs/${encodeURIComponent(record.runId)}/cancel`,
      },
    }
  }

  private respond(status: number, body: unknown, baseHeaders: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders },
    })
  }

  private redactToken(s: string): string {
    return this.token.length > 0 ? s.split(this.token).join("[redacted]") : s
  }
}

async function readBodyCapped(req: Request, maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  const reader = req.body?.getReader()
  if (!reader) {
    const txt = await req.text()
    return Buffer.byteLength(txt, "utf8") > maxBytes
      ? { text: "", tooLarge: true }
      : { text: txt, tooLarge: false }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        return { text: "", tooLarge: true }
      }
      chunks.push(value)
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: buf.toString("utf8"), tooLarge: false }
}

async function validateWorkspace(
  workspace: string,
  allowNonGit: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!workspace.startsWith("/")) return { ok: false, error: "workspace must be an absolute path" }
  try {
    const st = await fs.stat(workspace)
    if (!st.isDirectory()) return { ok: false, error: "workspace is not a directory" }
  } catch {
    return { ok: false, error: "workspace does not exist" }
  }
  if (!allowNonGit) {
    try {
      const gitSt = await fs.stat(join(workspace, ".git"))
      if (!gitSt.isDirectory()) return { ok: false, error: "workspace is not a git repo" }
    } catch {
      return { ok: false, error: "workspace is not a git repo" }
    }
  }
  return { ok: true }
}

async function writeTempIncidentFile(incidentJson: unknown, runId: string): Promise<string> {
  const tmp = process.env.PISTIS_TMP_DIR ?? "/tmp"
  const filePath = join(tmp, `pistis-incident-${runId}.json`)
  await fs.writeFile(filePath, JSON.stringify(incidentJson, null, 2), "utf8")
  return filePath
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function mapDispatchedToVerdict(result: RunPistisResult): RunRecord["verdict"] | undefined {
  if (!result.dispatched) return undefined
  return "accepted"
}

const RUN_OPTION_KEYS = new Set<keyof RunPistisOptions>([
  "neatUrl", "project", "testCommands", "outDir", "dryRun", "apply",
  "approveRisk", "worker", "workspace", "allowDirtyWorkspace", "allowNonGitWorkspace",
  "maxRetries", "multiAgent", "useRouter", "useKimiReviewer", "maxToolCalls",
])

function stripUnknown(input: Record<string, unknown>): Partial<RunPistisOptions> {
  const out: Partial<RunPistisOptions> = {}
  for (const key of Object.keys(input)) {
    if ((RUN_OPTION_KEYS as Set<string>).has(key)) {
      ;(out as Record<string, unknown>)[key] = input[key]
    }
  }
  return out
}
