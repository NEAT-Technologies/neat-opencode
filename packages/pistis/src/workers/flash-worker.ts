import type { Worker, WorkerWorkspace } from "../opencode/worker"
import type { AgentContract, AgentResult } from "../contract/types"
import { OutOfRoleError } from "./errors"
import {
  GRAPH_CONTEXT_SYSTEM_PROMPT,
  ROOT_CAUSE_SYSTEM_PROMPT,
  SECURITY_RISK_SYSTEM_PROMPT,
} from "./flash-prompts"

const SUPPORTED_ROLES = new Set(["graph_context", "root_cause", "security_risk"])

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const DEFAULT_MODEL = "gemini-3.5-flash"
const DEFAULT_TIMEOUT_MS = 15_000
const THINKING_TIMEOUT_MULTIPLIER = 3
const TRANSIENT_RETRY_LIMIT = 1
const RATE_LIMIT_BACKOFF_CAP_MS = 5_000

export interface FlashWorkerOptions {
  apiKey?: string
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }
  error?: { code?: number; message?: string; status?: string }
}

interface BuiltRequest {
  url: string
  body: unknown
  timeoutMs: number
  /** Per-role flag — true for root_cause. Drives the fallback retry path. */
  hasThinkingConfig: boolean
}

/**
 * FlashWorker — Gemini 3.5 Flash-backed Worker for Pistis reasoning roles.
 *
 * Handles graph_context, root_cause, security_risk. Throws OutOfRoleError
 * for any other role so the orchestrator (or a router worker) can dispatch
 * to a different Worker.
 *
 * See packages/pistis/phases/PHASE_4A_FLASH_WORKER.md for the spec this is
 * audited against.
 */
export class FlashWorker implements Worker {
  readonly name = "flash-worker"

  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: FlashWorkerOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY
    if (!apiKey || apiKey.length === 0) {
      throw new Error("FlashWorker: GEMINI_API_KEY is required (env or constructor option)")
    }
    this.apiKey = apiKey
    this.model = opts.model ?? process.env.PISTIS_FLASH_MODEL ?? DEFAULT_MODEL
    this.baseUrl = opts.baseUrl ?? process.env.PISTIS_FLASH_BASE_URL ?? DEFAULT_BASE_URL
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async run(contract: AgentContract, _workspace: WorkerWorkspace): Promise<AgentResult> {
    if (!SUPPORTED_ROLES.has(contract.agentRole)) {
      throw new OutOfRoleError(contract.agentRole, this.name)
    }

    if (contract.agentRole === "security_risk") {
      const prior = contract.inputs?.priorFindings ?? {}
      if (!prior.patch || prior.patch.filesChanged.length === 0) {
        return this.blocked(contract, "security_risk requires a prior patch role result")
      }
    }

    const request = this.buildRequest(contract)
    let resp: GeminiHttpResult
    try {
      resp = await this.dispatch(request)
    } catch (err) {
      return this.blocked(contract, redact(`Gemini unreachable: ${describeError(err)}`))
    }

    if (resp.kind === "blocked") return this.blocked(contract, resp.reason)
    if (resp.kind === "failed") return this.failed(contract, resp.reason)

    return this.mapToAgentResult(contract, resp.parsed)
  }

  private buildRequest(contract: AgentContract): BuiltRequest {
    const systemPrompt = systemPromptFor(contract.agentRole)
    const userMessage = buildUserMessage(contract)
    const enableThinking = contract.agentRole === "root_cause"

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: enableThinking ? -1 : 0 },
      },
    }

    return {
      url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      body,
      timeoutMs: enableThinking ? this.timeoutMs * THINKING_TIMEOUT_MULTIPLIER : this.timeoutMs,
      hasThinkingConfig: true,
    }
  }

  private async dispatch(request: BuiltRequest, attempt = 0): Promise<GeminiHttpResult> {
    const res = await this.fetchOnce(request)

    if (res.kind === "network") {
      if (attempt < TRANSIENT_RETRY_LIMIT) {
        return this.dispatch(request, attempt + 1)
      }
      return { kind: "blocked", reason: `Gemini unreachable: ${res.message}` }
    }

    if (res.kind === "http") {
      const status = res.status
      const bodyText = res.bodyText
      if (status === 401 || status === 403) {
        return { kind: "blocked", reason: "Gemini auth failed" }
      }
      if (status === 400 && request.hasThinkingConfig && /thinking[_ ]?config/i.test(bodyText)) {
        const downgraded = stripThinkingConfig(request)
        return this.dispatch(downgraded, attempt)
      }
      if (status === 429) {
        if (attempt < TRANSIENT_RETRY_LIMIT) {
          const wait = Math.min(parseRetryAfter(res.retryAfter), RATE_LIMIT_BACKOFF_CAP_MS)
          await sleep(wait)
          return this.dispatch(request, attempt + 1)
        }
        return { kind: "blocked", reason: "Gemini rate limited" }
      }
      if (status >= 500 && status < 600) {
        if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(request, attempt + 1)
        return { kind: "blocked", reason: `Gemini server error: ${status}` }
      }
      return { kind: "blocked", reason: `Gemini HTTP ${status}` }
    }

    const parsed = res.payload
    const finishReason = parsed.candidates?.[0]?.finishReason
    if (finishReason === "SAFETY" || finishReason === "BLOCKLIST" || finishReason === "PROHIBITED_CONTENT") {
      return { kind: "blocked", reason: `Gemini blocked output for ${finishReason.toLowerCase()}` }
    }

    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text || text.length === 0) {
      return { kind: "blocked", reason: "Gemini returned empty output" }
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { kind: "blocked", reason: `Gemini returned non-JSON output: ${text.slice(0, 200)}` }
    }
    if (typeof json !== "object" || json === null) {
      return { kind: "failed", reason: "Gemini output was not a JSON object" }
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
          "x-goog-api-key": this.apiKey,
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
      let payload: GeminiResponse
      try {
        payload = JSON.parse(bodyText) as GeminiResponse
      } catch {
        return { kind: "http", status: 502, bodyText: "Gemini returned non-JSON envelope", retryAfter: undefined }
      }
      return { kind: "payload", payload }
    } catch (err) {
      return { kind: "network", message: describeError(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private mapToAgentResult(contract: AgentContract, parsed: Record<string, unknown>): AgentResult {
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined
    if (!summary) return this.failed(contract, "Gemini output missing field: summary")
    const riskNotes = asStringArray(parsed.riskNotes)
    const unresolvedQuestions = asStringArray(parsed.unresolvedQuestions)

    if (
      contract.agentRole === "security_risk" &&
      /security_risk requires a prior patch result/i.test(summary)
    ) {
      return this.blocked(contract, summary)
    }

    return {
      contractId: contract.contractId,
      status: "completed",
      summary,
      filesChanged: [],
      testsRun: [],
      riskNotes,
      unresolvedQuestions,
    }
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
}

type GeminiHttpResult =
  | { kind: "ok"; parsed: Record<string, unknown> }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }

type FetchOnceResult =
  | { kind: "payload"; payload: GeminiResponse }
  | { kind: "http"; status: number; bodyText: string; retryAfter: string | undefined }
  | { kind: "network"; message: string }

function systemPromptFor(role: string): string {
  switch (role) {
    case "graph_context": return GRAPH_CONTEXT_SYSTEM_PROMPT
    case "root_cause":    return ROOT_CAUSE_SYSTEM_PROMPT
    case "security_risk": return SECURITY_RISK_SYSTEM_PROMPT
  }
  throw new Error(`no system prompt for role: ${role}`)
}

/**
 * The user message has three blocks, concatenated in this order:
 *   1. STABLE_INCIDENT_AND_GRAPH — identical across reasoning roles in the same run
 *   2. PRIOR_FINDINGS_BLOCK — only present from root_cause onwards
 *   3. ROLE_TAIL — the ask
 *
 * Block 1's byte-stability is what enables Gemini's implicit prefix cache to
 * hit across the three reasoning roles within a single orchestration run.
 */
function buildUserMessage(contract: AgentContract): string {
  const stable = buildStablePrefix(contract)
  const prior = buildPriorFindingsBlock(contract)
  const tail = buildRoleTail(contract)
  return prior
    ? `${stable}\n\n${prior}\n\n${tail}`
    : `${stable}\n\n${tail}`
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
  return [
    "=== PRIOR FINDINGS ===",
    JSON.stringify(prior, null, 2),
  ].join("\n")
}

function buildRoleTail(contract: AgentContract): string {
  const ask = `Produce the JSON output for the ${contract.agentRole} role as defined in the system prompt. Contract objective: ${contract.objective}`
  return ask
}

function extractIncident(graphContext: unknown): unknown {
  if (typeof graphContext !== "object" || graphContext === null) return null
  const gc = graphContext as Record<string, unknown>
  return gc.incident ?? null
}

function stripThinkingConfig(request: BuiltRequest): BuiltRequest {
  const body = JSON.parse(JSON.stringify(request.body)) as Record<string, unknown>
  const cfg = body.generationConfig as Record<string, unknown> | undefined
  if (cfg && "thinkingConfig" in cfg) delete cfg.thinkingConfig
  return { ...request, body, hasThinkingConfig: false }
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

/**
 * Defensive redactor: removes any substring that looks like a Google API key
 * from a string before it lands in an AgentResult.summary. Google keys begin
 * with "AIza" and are followed by ~35 base64-ish characters.
 */
function redact(s: string): string {
  return s.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[redacted]")
}
