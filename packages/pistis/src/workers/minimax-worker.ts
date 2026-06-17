import { promises as fs } from "node:fs"
import { join, resolve, relative } from "node:path"
import type { Worker, WorkerWorkspace } from "../opencode/worker"
import type { AgentContract, AgentResult } from "../contract/types"
import { OutOfRoleError } from "./errors"
import { PATCH_SYSTEM_PROMPT, MIGRATION_SYSTEM_PROMPT } from "./minimax-prompts"
import { parseUnifiedDiff, validateDiffPaths, DiffParseError } from "./diff-parser"
import { defaultGitApply, type GitApplyFn } from "./git-apply"

const SUPPORTED_ROLES = new Set(["patch", "migration"])

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1"
const DEFAULT_MODEL = "MiniMax-M3"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_PER_FILE_BYTE_CAP = 32 * 1024
const DEFAULT_BUNDLE_BYTE_CAP = 256 * 1024
const TRANSIENT_RETRY_LIMIT = 1
const RATE_LIMIT_BACKOFF_CAP_MS = 5_000
const MAX_TOKENS = 8192

export interface MinimaxWorkerOptions {
  apiKey?: string
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  gitApply?: GitApplyFn
  fileBundleByteCap?: number
  perFileByteCap?: number
}

interface OpenAIResponse {
  id?: string
  choices?: Array<{
    message?: { role?: string; content?: string }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; type?: string; code?: string }
}

interface BuiltRequest {
  url: string
  body: Record<string, unknown>
  timeoutMs: number
  hasResponseFormat: boolean
  riskNotes: string[]
}

export class MinimaxWorker implements Worker {
  readonly name = "minimax-worker"

  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly gitApply: GitApplyFn
  private readonly bundleCap: number
  private readonly perFileCap: number

  constructor(opts: MinimaxWorkerOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.MINIMAX_API_KEY
    if (!apiKey || apiKey.length === 0) {
      throw new Error("MinimaxWorker: MINIMAX_API_KEY is required (env or constructor option)")
    }
    this.apiKey = apiKey
    this.model = opts.model ?? process.env.PISTIS_MINIMAX_MODEL ?? DEFAULT_MODEL
    this.baseUrl = opts.baseUrl ?? process.env.PISTIS_MINIMAX_BASE_URL ?? DEFAULT_BASE_URL
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.gitApply = opts.gitApply ?? defaultGitApply
    this.bundleCap = opts.fileBundleByteCap ?? DEFAULT_BUNDLE_BYTE_CAP
    this.perFileCap = opts.perFileByteCap ?? DEFAULT_PER_FILE_BYTE_CAP
  }

  async run(contract: AgentContract, workspace: WorkerWorkspace): Promise<AgentResult> {
    if (!SUPPORTED_ROLES.has(contract.agentRole)) {
      throw new OutOfRoleError(contract.agentRole, this.name)
    }
    if (!workspace.isGitRepo) {
      return this.failed(contract, "MinimaxWorker requires a git workspace (workspace.isGitRepo === false)")
    }

    let bundle: BundledFiles
    try {
      bundle = await this.bundleAllowedFiles(contract, workspace)
    } catch (err) {
      if (err instanceof BundleCapError) {
        return this.failed(contract, err.message)
      }
      throw err
    }

    const request = this.buildRequest(contract, bundle)

    let resp: MinimaxResult
    try {
      resp = await this.dispatch(request)
    } catch (err) {
      return this.blocked(contract, this.redact(`MiniMax unreachable: ${describeError(err)}`))
    }

    if (resp.kind === "blocked") return this.blocked(contract, this.redact(resp.reason))
    if (resp.kind === "failed") return this.failed(contract, this.redact(resp.reason))

    const parsed = resp.parsed
    const diff = typeof parsed.diff === "string" ? parsed.diff : undefined
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined
    if (!summary) return this.failed(contract, "MiniMax output missing field: summary")
    if (!diff || diff.length === 0) return this.failed(contract, "MiniMax output missing field: diff")

    let parsedDiff
    try {
      parsedDiff = parseUnifiedDiff(diff)
    } catch (err) {
      if (err instanceof DiffParseError) {
        return this.blocked(contract, `MiniMax produced an unparseable diff: ${err.message}`)
      }
      throw err
    }

    const violation = validateDiffPaths(parsedDiff, contract.allowedFiles, contract.forbiddenFiles)
    if (violation) {
      return this.blocked(
        contract,
        `diff touched disallowed file: ${violation.offending} (${violation.reason})`,
      )
    }

    const apply = await this.gitApply(workspace.cwd, diff)
    if (!apply.ok) {
      const firstLine = (apply.stderr || "").split("\n").find((l) => l.trim().length > 0) ?? "unknown error"
      return this.failed(contract, `git apply failed: ${firstLine}`)
    }

    const filesChanged = parsedDiff.entries.map((e) => e.path)
    const riskNotesFromModel = asStringArray(parsed.riskNotes)
    const riskNotes = [...bundle.riskNotes, ...riskNotesFromModel]
    return {
      contractId: contract.contractId,
      status: "completed",
      summary,
      filesChanged,
      testsRun: [],
      diff,
      riskNotes,
      unresolvedQuestions: asStringArray(parsed.unresolvedQuestions),
    }
  }

  private buildRequest(contract: AgentContract, bundle: BundledFiles): BuiltRequest {
    const systemPrompt = systemPromptFor(contract.agentRole)
    const userMessage = buildUserMessage(contract, bundle)

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: MAX_TOKENS,
    }
    return {
      url: `${this.baseUrl}/chat/completions`,
      body,
      timeoutMs: this.timeoutMs,
      hasResponseFormat: true,
      riskNotes: bundle.riskNotes,
    }
  }

  private async dispatch(request: BuiltRequest, attempt = 0): Promise<MinimaxResult> {
    const res = await this.fetchOnce(request)

    if (res.kind === "network") {
      if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(request, attempt + 1)
      return { kind: "blocked", reason: `MiniMax unreachable: ${res.message}` }
    }

    if (res.kind === "http") {
      const status = res.status
      const bodyText = res.bodyText
      if (status === 401 || status === 403) {
        return { kind: "blocked", reason: "MiniMax auth failed" }
      }
      if (status === 400 && request.hasResponseFormat && /response_format/i.test(bodyText)) {
        const downgraded = stripResponseFormat(request)
        return this.dispatch(downgraded, attempt)
      }
      if (status === 429) {
        if (attempt < TRANSIENT_RETRY_LIMIT) {
          await sleep(Math.min(parseRetryAfter(res.retryAfter), RATE_LIMIT_BACKOFF_CAP_MS))
          return this.dispatch(request, attempt + 1)
        }
        return { kind: "blocked", reason: "MiniMax rate limited" }
      }
      if (status >= 500 && status < 600) {
        if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(request, attempt + 1)
        return { kind: "blocked", reason: `MiniMax server error: ${status}` }
      }
      return { kind: "blocked", reason: `MiniMax HTTP ${status}` }
    }

    const parsed = res.payload
    const choice = parsed.choices?.[0]
    const finishReason = choice?.finish_reason
    if (finishReason === "content_filter") {
      return { kind: "blocked", reason: "MiniMax blocked output for content_filter" }
    }
    if (finishReason === "length") {
      return { kind: "failed", reason: "MiniMax output truncated — increase max_tokens or split contract" }
    }

    const content = choice?.message?.content
    if (!content || content.length === 0) {
      return { kind: "blocked", reason: "MiniMax returned empty output" }
    }

    const unfenced = stripFences(content)
    let json: unknown
    try {
      json = JSON.parse(unfenced)
    } catch {
      return {
        kind: "blocked",
        reason: `MiniMax returned non-JSON output: ${unfenced.slice(0, 200)}`,
      }
    }
    if (typeof json !== "object" || json === null) {
      return { kind: "failed", reason: "MiniMax output was not a JSON object" }
    }
    return { kind: "ok", parsed: json as Record<string, unknown> }
  }

  private async fetchOnce(request: BuiltRequest): Promise<FetchOnceResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const res = await this.fetchImpl(request.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      const bodyText = await res.text()
      if (!res.ok) {
        return {
          kind: "http",
          status: res.status,
          bodyText,
          retryAfter: res.headers.get("retry-after") ?? undefined,
        }
      }
      let payload: OpenAIResponse
      try {
        payload = JSON.parse(bodyText) as OpenAIResponse
      } catch {
        return {
          kind: "http",
          status: 502,
          bodyText: "MiniMax returned non-JSON envelope",
          retryAfter: undefined,
        }
      }
      return { kind: "payload", payload }
    } catch (err) {
      return { kind: "network", message: describeError(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async bundleAllowedFiles(contract: AgentContract, workspace: WorkerWorkspace): Promise<BundledFiles> {
    const items: BundledFile[] = []
    const riskNotes: string[] = []
    let totalBytes = 0
    for (const allowed of contract.allowedFiles) {
      const abs = safeResolve(workspace.cwd, allowed)
      if (!abs) {
        items.push({ path: allowed, present: false, content: "" })
        continue
      }
      let raw: Buffer | null = null
      try {
        raw = await fs.readFile(abs)
      } catch {
        items.push({ path: allowed, present: false, content: "" })
        continue
      }
      if (isProbablyBinary(raw)) {
        items.push({ path: allowed, present: true, content: "<binary file omitted>" })
        riskNotes.push(`file ${allowed} appears binary; not included in prompt`)
        continue
      }
      let text = raw.toString("utf8")
      if (raw.length > this.perFileCap) {
        text = raw.subarray(0, this.perFileCap).toString("utf8") +
          `\n<truncated: ${raw.length - this.perFileCap} bytes>`
        riskNotes.push(`file ${allowed} was truncated; patch may be incomplete`)
      }
      const contentBytes = Buffer.byteLength(text, "utf8")
      if (totalBytes + contentBytes > this.bundleCap) {
        throw new BundleCapError(`allowedFiles content exceeds ${this.bundleCap} byte bundle cap`)
      }
      totalBytes += contentBytes
      items.push({ path: allowed, present: true, content: text })
    }
    return { items, riskNotes }
  }

  private blocked(contract: AgentContract, reason: string): AgentResult {
    return {
      contractId: contract.contractId,
      status: "blocked",
      summary: reason,
      filesChanged: [],
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: [],
    }
  }

  private failed(contract: AgentContract, reason: string): AgentResult {
    return {
      contractId: contract.contractId,
      status: "failed",
      summary: reason,
      filesChanged: [],
      testsRun: [],
      riskNotes: [],
      unresolvedQuestions: [],
    }
  }

  /**
   * Replace the literal API key with [redacted] wherever it appears in
   * an output string. Simple substring replacement covers any key format.
   */
  private redact(s: string): string {
    if (this.apiKey.length === 0) return s
    return s.split(this.apiKey).join("[redacted]")
  }
}

type MinimaxResult =
  | { kind: "ok"; parsed: Record<string, unknown> }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }

type FetchOnceResult =
  | { kind: "payload"; payload: OpenAIResponse }
  | { kind: "http"; status: number; bodyText: string; retryAfter: string | undefined }
  | { kind: "network"; message: string }

interface BundledFile {
  path: string
  present: boolean
  content: string
}

interface BundledFiles {
  items: BundledFile[]
  riskNotes: string[]
}

class BundleCapError extends Error {
  override readonly name = "BundleCapError"
}

function systemPromptFor(role: string): string {
  switch (role) {
    case "patch":     return PATCH_SYSTEM_PROMPT
    case "migration": return MIGRATION_SYSTEM_PROMPT
  }
  throw new Error(`no system prompt for role: ${role}`)
}

function buildUserMessage(contract: AgentContract, bundle: BundledFiles): string {
  const stable = buildStablePrefix(contract)
  const prior = buildPriorFindingsBlock(contract)
  const tail = buildRoleTail(contract, bundle)
  return prior ? `${stable}\n\n${prior}\n\n${tail}` : `${stable}\n\n${tail}`
}

function buildStablePrefix(contract: AgentContract): string {
  return [
    "=== INCIDENT ===",
    JSON.stringify(extractIncident(contract.graphContext), null, 2),
    "",
    "=== GRAPH CONTEXT ===",
    JSON.stringify(contract.graphContext, null, 2),
  ].join("\n")
}

function buildPriorFindingsBlock(contract: AgentContract): string | null {
  const prior = contract.inputs?.priorFindings
  if (!prior || Object.keys(prior).length === 0) return null
  return ["=== PRIOR FINDINGS ===", JSON.stringify(prior, null, 2)].join("\n")
}

function buildRoleTail(contract: AgentContract, bundle: BundledFiles): string {
  const blocks: string[] = []
  blocks.push("=== CONTRACT ===")
  blocks.push(JSON.stringify({
    objective: contract.objective,
    allowedFiles: contract.allowedFiles,
    forbiddenFiles: contract.forbiddenFiles,
    constraints: contract.constraints,
    successCriteria: contract.successCriteria,
    requiredOutputs: contract.requiredOutputs,
  }, null, 2))
  for (const item of bundle.items) {
    blocks.push(`=== FILE: ${item.path} ===`)
    blocks.push(item.present ? item.content : "<file does not exist yet — worker must create it>")
  }
  blocks.push(
    `Produce the JSON output for the ${contract.agentRole} role as defined in the system prompt. ` +
      `Contract objective: ${contract.objective}`,
  )
  return blocks.join("\n")
}

function extractIncident(graphContext: unknown): unknown {
  if (typeof graphContext !== "object" || graphContext === null) return null
  const gc = graphContext as Record<string, unknown>
  return gc.incident ?? null
}

function stripResponseFormat(request: BuiltRequest): BuiltRequest {
  const body = JSON.parse(JSON.stringify(request.body)) as Record<string, unknown>
  delete body.response_format
  return { ...request, body, hasResponseFormat: false }
}

function stripFences(content: string): string {
  const trimmed = content.trim()
  if (trimmed.startsWith("```")) {
    const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
    if (match) return match[1]
  }
  return trimmed
}

function parseRetryAfter(value: string | undefined): number {
  if (!value) return 1_000
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000)
  return 1_000
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted/i.test(err.message)) return "request timed out"
    return err.message
  }
  return String(err)
}

function safeResolve(root: string, rel: string): string | null {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  if (r.startsWith("..") || r === "" || r.startsWith("/")) return null
  return abs
}

function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 1024))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

// re-export so callers can mkdir migrations/ if they want; not used in this file
export { join }
