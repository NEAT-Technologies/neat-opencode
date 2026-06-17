import type { AsyncContractReviewer, AsyncContractReviewerInput } from "../contract/async-reviewer"
import type { ContractReview } from "../contract/types"
import type { NeatClient } from "../neat/client"
import { NeatReadOnlyClient, type ToolResult } from "./neat-readonly-client"
import { READ_ONLY_TOOLS, TOOL_NAMES, type MoonshotTool, type ToolName } from "./kimi-tools"
import { VERIFY_SYSTEM_PROMPT, BUGFIX_SYSTEM_PROMPT } from "./kimi-prompts"
import {
  type AppendToolCallLog,
  hashToolResult,
  noopAppendToolCallLog,
  type ToolCallLogLine,
} from "./tool-call-log"

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1"
const DEFAULT_MODEL = "kimi-k2-7-instruct"
const DEFAULT_TIMEOUT_MS = 60_000
const BUGFIX_TIMEOUT_MULTIPLIER = 2
const DEFAULT_MAX_TOOL_CALLS = 8
const MIN_MAX_TOOL_CALLS = 1
const MAX_MAX_TOOL_CALLS = 16
const PER_TOOL_CALL_TIMEOUT_MS = 10_000
const TRANSIENT_RETRY_LIMIT = 1
const RATE_LIMIT_BACKOFF_CAP_MS = 5_000

export interface KimiReviewerOptions {
  neatClient: NeatClient
  apiKey?: string
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxToolCalls?: number
  attemptBugfixOnReject?: boolean
  appendToolCallLog?: AppendToolCallLog
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIResponse {
  id?: string
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: OpenAIToolCall[] }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; type?: string; code?: string }
}

interface CallOptions {
  timeoutMs: number
  withTools: boolean
}

/**
 * KimiReviewer: Moonshot Kimi K2.7-backed AsyncContractReviewer.
 *
 * Three phases:
 *   1. VERIFY — tool-using loop, up to maxToolCalls NEAT lookups
 *   2. DECIDE — parse Kimi's final JSON, map to ContractReview
 *   3. BUGFIX (optional) — fresh call with tools=[] producing a corrected diff
 *
 * Audited against packages/pistis/phases/PHASE_4C_KIMI_REVIEWER.md.
 */
export class KimiReviewer implements AsyncContractReviewer {
  readonly name = "kimi-reviewer"

  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly neat: NeatReadOnlyClient
  private readonly maxToolCalls: number
  private readonly attemptBugfix: boolean
  private readonly appendToolCallLog: AppendToolCallLog

  constructor(opts: KimiReviewerOptions) {
    const apiKey = opts.apiKey ?? process.env.MOONSHOT_API_KEY
    if (!apiKey || apiKey.length === 0) {
      throw new Error("KimiReviewer: MOONSHOT_API_KEY is required (env or constructor option)")
    }
    this.apiKey = apiKey
    this.model = opts.model ?? process.env.PISTIS_MOONSHOT_MODEL ?? DEFAULT_MODEL
    this.baseUrl = opts.baseUrl ?? process.env.PISTIS_MOONSHOT_BASE_URL ?? DEFAULT_BASE_URL
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.neat = new NeatReadOnlyClient(opts.neatClient)
    const envBudget = process.env.PISTIS_KIMI_TOOL_BUDGET
    const requested =
      opts.maxToolCalls ??
      (envBudget !== undefined ? Number(envBudget) : DEFAULT_MAX_TOOL_CALLS)
    this.maxToolCalls = clamp(
      Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_TOOL_CALLS,
      MIN_MAX_TOOL_CALLS,
      MAX_MAX_TOOL_CALLS,
    )
    this.attemptBugfix = opts.attemptBugfixOnReject ?? true
    this.appendToolCallLog = opts.appendToolCallLog ?? noopAppendToolCallLog()
  }

  async review(input: AsyncContractReviewerInput): Promise<ContractReview> {
    const { contract, result } = input

    if (!result.diff || result.diff.length === 0) {
      return this.escalate(contract, ["KimiReviewer: AgentResult has no diff to review"])
    }

    const initialMessages: OpenAIMessage[] = [
      { role: "system", content: VERIFY_SYSTEM_PROMPT },
      { role: "user", content: buildVerifyUserMessage(input) },
    ]

    const verify = await this.runVerifyLoop(input, initialMessages)
    if (verify.kind === "escalate") return this.escalate(contract, verify.reasons)
    if (verify.kind === "decided") {
      const decision = verify.decision
      if (decision.verdict === "accepted") {
        return {
          contractId: contract.contractId,
          verdict: "accepted",
          reasons: decision.reasons,
          criteriaResults: decision.criteriaResults,
        }
      }
      if (decision.verdict === "needs_retry") {
        return {
          contractId: contract.contractId,
          verdict: "needs_retry",
          reasons: decision.reasons,
          criteriaResults: decision.criteriaResults,
          nextPrompt: decision.reasons.join("\n"),
        }
      }
      // rejected
      if (this.attemptBugfix) {
        const bugfix = await this.runBugfixPhase(input, decision)
        if (bugfix.kind === "fix") {
          return {
            contractId: contract.contractId,
            verdict: "needs_retry",
            reasons: [`KimiReviewer rejected and produced a bugfix: ${bugfix.summary}`],
            criteriaResults: decision.criteriaResults,
            nextPrompt: serialiseBugfix(bugfix),
          }
        }
        // bugfix failed → fall through to rejected with the original reasons
      }
      return {
        contractId: contract.contractId,
        verdict: "rejected",
        reasons: decision.reasons,
        criteriaResults: decision.criteriaResults,
      }
    }
    // Unreachable.
    return this.escalate(contract, ["KimiReviewer: unreachable code path"])
  }

  private async runVerifyLoop(
    input: AsyncContractReviewerInput,
    messages: OpenAIMessage[],
  ): Promise<VerifyOutcome> {
    let toolCallsMade = 0
    while (true) {
      const resp = await this.dispatch(messages, { timeoutMs: this.timeoutMs, withTools: true })
      if (resp.kind === "escalate") return { kind: "escalate", reasons: resp.reasons }

      const choice = resp.payload.choices?.[0]
      const message = choice?.message ?? {}
      const finishReason = choice?.finish_reason

      if (finishReason === "length") {
        return { kind: "escalate", reasons: ["KimiReviewer output truncated"] }
      }
      if (finishReason === "content_filter") {
        return { kind: "escalate", reasons: ["KimiReviewer blocked by content filter"] }
      }

      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length === 0) {
        const decision = parseDecision(message.content ?? "")
        if (decision.kind === "err") {
          return { kind: "escalate", reasons: [`KimiReviewer output not JSON: ${decision.preview}`] }
        }
        return { kind: "decided", decision: decision.decision }
      }

      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: toolCalls,
      })

      for (const call of toolCalls) {
        if (toolCallsMade >= this.maxToolCalls) {
          return { kind: "escalate", reasons: ["iteration cap hit"] }
        }
        toolCallsMade++
        const toolMsg = await this.executeToolCall(call, input, toolCallsMade)
        messages.push(toolMsg)
      }
    }
  }

  private async executeToolCall(
    call: OpenAIToolCall,
    input: AsyncContractReviewerInput,
    iteration: number,
  ): Promise<OpenAIMessage> {
    const name = call.function.name
    const startTs = Date.now()
    const startedAt = new Date(startTs).toISOString()

    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.function.arguments || "{}")
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("arguments must be a JSON object")
      }
    } catch {
      await this.logToolCall({
        ts: startedAt,
        iteration,
        tool: name,
        args: {},
        ok: false,
        error: "bad_arguments",
      })
      return toolMessage(call.id, { ok: false, error: "tool arguments were not valid JSON" })
    }

    if (!(TOOL_NAMES as ReadonlySet<string>).has(name)) {
      await this.logToolCall({
        ts: startedAt,
        iteration,
        tool: name,
        args,
        ok: false,
        error: "unknown_tool",
      })
      return toolMessage(call.id, { ok: false, error: "tool not in allowlist" })
    }

    const result = await this.runToolWithTimeout(name as ToolName, args, input)
    const latencyMs = Date.now() - startTs
    await this.logToolCall({
      ts: startedAt,
      iteration,
      tool: name,
      args,
      ok: result.ok,
      result_hash: hashToolResult(result),
      latency_ms: latencyMs,
      ...(result.ok ? {} : { error: result.error }),
    })
    return toolMessage(call.id, result)
  }

  private async runToolWithTimeout(
    name: ToolName,
    args: Record<string, unknown>,
    input: AsyncContractReviewerInput,
  ): Promise<ToolResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timeoutId = setTimeout(() => resolve({ ok: false, error: "tool timed out" }), PER_TOOL_CALL_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.invokeTool(name, args, input), timeoutPromise])
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  private async invokeTool(
    name: ToolName,
    args: Record<string, unknown>,
    input: AsyncContractReviewerInput,
  ): Promise<ToolResult> {
    const nodeIdArg = typeof args.nodeId === "string" && args.nodeId.length > 0 ? args.nodeId : input.primaryNodeId
    const depthArg = typeof args.depth === "number" ? args.depth : undefined
    const limitArg = typeof args.limit === "number" ? args.limit : undefined
    const errorIdArg = typeof args.errorId === "string" ? args.errorId : undefined
    const severityArg = typeof args.severity === "string" ? args.severity : undefined
    const policyIdArg = typeof args.policyId === "string" ? args.policyId : undefined

    switch (name) {
      case "get_node":              return this.neat.getNode(nodeIdArg)
      case "get_edges":             return this.neat.getEdges(nodeIdArg)
      case "get_blast_radius":      return this.neat.getBlastRadius(nodeIdArg, depthArg)
      case "get_dependencies":      return this.neat.getDependencies(nodeIdArg, depthArg)
      case "get_root_cause":        return this.neat.getRootCause(nodeIdArg, errorIdArg)
      case "get_divergences":       return this.neat.getDivergences(typeof args.nodeId === "string" ? args.nodeId : undefined)
      case "list_incidents":        return this.neat.listIncidents(limitArg)
      case "get_policy_violations": return this.neat.getPolicyViolations({ severity: severityArg, policyId: policyIdArg })
    }
  }

  private async runBugfixPhase(
    input: AsyncContractReviewerInput,
    decision: ParsedDecision,
  ): Promise<BugfixOutcome> {
    const messages: OpenAIMessage[] = [
      { role: "system", content: BUGFIX_SYSTEM_PROMPT },
      { role: "user", content: buildBugfixUserMessage(input, decision) },
    ]
    const resp = await this.dispatch(messages, {
      timeoutMs: this.timeoutMs * BUGFIX_TIMEOUT_MULTIPLIER,
      withTools: false,
    })
    if (resp.kind === "escalate") return { kind: "failed", reason: resp.reasons.join("; ") }

    const choice = resp.payload.choices?.[0]
    const finishReason = choice?.finish_reason
    if (finishReason === "length" || finishReason === "content_filter") {
      return { kind: "failed", reason: `bugfix ${finishReason}` }
    }
    const content = choice?.message?.content ?? ""
    let parsed: unknown
    try {
      parsed = JSON.parse(content.trim())
    } catch {
      return { kind: "failed", reason: "bugfix non-JSON" }
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "failed", reason: "bugfix not a JSON object" }
    }
    const obj = parsed as Record<string, unknown>
    const summary = typeof obj.summary === "string" ? obj.summary : ""
    const diff = typeof obj.diff === "string" ? obj.diff : ""
    const filesChanged = asStringArray(obj.filesChanged)
    if (summary.length === 0 || diff.length === 0) {
      return { kind: "failed", reason: "bugfix missing summary or diff" }
    }
    return { kind: "fix", summary, diff, filesChanged }
  }

  private async dispatch(messages: OpenAIMessage[], opts: CallOptions, attempt = 0): Promise<DispatchResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
    }
    if (opts.withTools) {
      body.tools = READ_ONLY_TOOLS as unknown as MoonshotTool[]
      body.tool_choice = "auto"
    } else {
      body.tools = [] as MoonshotTool[]
    }

    let res: Awaited<ReturnType<typeof fetchOnce>>
    try {
      res = await fetchOnce(this.fetchImpl, `${this.baseUrl}/chat/completions`, body, this.apiKey, opts.timeoutMs)
    } catch (err) {
      if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(messages, opts, attempt + 1)
      return { kind: "escalate", reasons: [this.redact(`KimiReviewer unreachable: ${describeError(err)}`)] }
    }

    if (res.kind === "network") {
      if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(messages, opts, attempt + 1)
      return { kind: "escalate", reasons: [this.redact(`KimiReviewer unreachable: ${res.message}`)] }
    }
    if (res.kind === "http") {
      if (res.status === 401 || res.status === 403) {
        return { kind: "escalate", reasons: ["KimiReviewer auth failed"] }
      }
      if (res.status === 429) {
        if (attempt < TRANSIENT_RETRY_LIMIT) {
          await sleep(Math.min(parseRetryAfter(res.retryAfter), RATE_LIMIT_BACKOFF_CAP_MS))
          return this.dispatch(messages, opts, attempt + 1)
        }
        return { kind: "escalate", reasons: ["KimiReviewer rate limited"] }
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < TRANSIENT_RETRY_LIMIT) return this.dispatch(messages, opts, attempt + 1)
        return { kind: "escalate", reasons: [`KimiReviewer server error: ${res.status}`] }
      }
      return { kind: "escalate", reasons: [`KimiReviewer HTTP ${res.status}`] }
    }
    return { kind: "payload", payload: res.payload }
  }

  private async logToolCall(line: ToolCallLogLine): Promise<void> {
    try {
      await this.appendToolCallLog(JSON.stringify(line) + "\n")
    } catch {
      // Logging must never crash the reviewer loop.
    }
  }

  private escalate(contract: { contractId: string }, reasons: string[]): ContractReview {
    return {
      contractId: contract.contractId,
      verdict: "needs_human",
      reasons,
      criteriaResults: [],
    }
  }

  private redact(s: string): string {
    if (!this.apiKey || this.apiKey.length === 0) return s
    return s.split(this.apiKey).join("[redacted]")
  }
}

type VerifyOutcome =
  | { kind: "decided"; decision: ParsedDecision }
  | { kind: "escalate"; reasons: string[] }

type DispatchResult =
  | { kind: "payload"; payload: OpenAIResponse }
  | { kind: "escalate"; reasons: string[] }

type BugfixOutcome =
  | { kind: "fix"; summary: string; diff: string; filesChanged: string[] }
  | { kind: "failed"; reason: string }

interface ParsedDecision {
  verdict: "accepted" | "rejected" | "needs_retry"
  reasons: string[]
  criteriaResults: Array<{ criterion: string; status: "pass" | "fail" | "unknown"; evidence: string[] }>
}

function parseDecision(content: string): { kind: "ok"; decision: ParsedDecision } | { kind: "err"; preview: string } {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { kind: "err", preview: "<empty>" }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(trimmed))
  } catch {
    return { kind: "err", preview: trimmed.slice(0, 200) }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "err", preview: trimmed.slice(0, 200) }
  }
  const obj = parsed as Record<string, unknown>
  const verdict = obj.verdict
  if (verdict !== "accepted" && verdict !== "rejected" && verdict !== "needs_retry") {
    return { kind: "err", preview: trimmed.slice(0, 200) }
  }
  const reasons = asStringArray(obj.reasons)
  const criteriaRaw = Array.isArray(obj.criteriaResults) ? obj.criteriaResults : []
  const criteriaResults = criteriaRaw
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => {
      const status: "pass" | "fail" | "unknown" =
        c.status === "pass" || c.status === "fail" || c.status === "unknown" ? c.status : "unknown"
      return {
        criterion: typeof c.criterion === "string" ? c.criterion : "",
        status,
        evidence: asStringArray(c.evidence),
      }
    })
  return { kind: "ok", decision: { verdict, reasons, criteriaResults } }
}

function buildVerifyUserMessage(input: AsyncContractReviewerInput): string {
  const { contract, result, incident, graphContext } = input
  const blocks: string[] = []
  blocks.push("=== INCIDENT ===")
  blocks.push(JSON.stringify(incident, null, 2))
  blocks.push("")
  blocks.push("=== GRAPH CONTEXT ===")
  blocks.push(JSON.stringify(graphContext, null, 2))
  blocks.push("")
  blocks.push("=== CONTRACT ===")
  blocks.push(
    JSON.stringify(
      {
        contractId: contract.contractId,
        agentRole: contract.agentRole,
        objective: contract.objective,
        allowedFiles: contract.allowedFiles,
        forbiddenFiles: contract.forbiddenFiles,
        constraints: contract.constraints,
        successCriteria: contract.successCriteria,
        maxRetries: contract.maxRetries,
      },
      null,
      2,
    ),
  )
  blocks.push("")
  blocks.push("=== PATCH SUMMARY ===")
  blocks.push(result.summary)
  blocks.push("")
  blocks.push("=== DIFF ===")
  blocks.push(result.diff ?? "")
  if (input.testRuns && input.testRuns.length > 0) {
    blocks.push("")
    blocks.push("=== TEST RUNS ===")
    blocks.push(
      input.testRuns
        .map((r) => `$ ${r.command}\nexit=${r.exitCode}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`)
        .join("\n---\n"),
    )
  }
  if (result.riskNotes.length > 0) {
    blocks.push("")
    blocks.push("=== WORKER RISK NOTES ===")
    blocks.push(result.riskNotes.map((n) => `- ${n}`).join("\n"))
  }
  blocks.push("")
  blocks.push(`primaryNodeId: ${input.primaryNodeId}`)
  blocks.push("")
  blocks.push("Decide: accepted | rejected | needs_retry. Use tools as needed; you have a budget of tool calls. Emit final JSON only when ready.")
  return blocks.join("\n")
}

function buildBugfixUserMessage(input: AsyncContractReviewerInput, decision: ParsedDecision): string {
  const { contract, result, incident } = input
  const blocks: string[] = []
  blocks.push("=== INCIDENT ===")
  blocks.push(JSON.stringify(incident, null, 2))
  blocks.push("")
  blocks.push("=== CONTRACT ===")
  blocks.push(
    JSON.stringify(
      {
        contractId: contract.contractId,
        agentRole: contract.agentRole,
        objective: contract.objective,
        allowedFiles: contract.allowedFiles,
        forbiddenFiles: contract.forbiddenFiles,
        constraints: contract.constraints,
        successCriteria: contract.successCriteria,
      },
      null,
      2,
    ),
  )
  blocks.push("")
  blocks.push("=== REJECTED DIFF ===")
  blocks.push(result.diff ?? "")
  blocks.push("")
  blocks.push("=== VERIFY VERDICT ===")
  blocks.push(JSON.stringify(decision, null, 2))
  blocks.push("")
  blocks.push(
    "Produce a corrected unified diff per the BUGFIX rules. Output ONLY the JSON object — no prose, no fences.",
  )
  return blocks.join("\n")
}

function serialiseBugfix(bugfix: { summary: string; diff: string; filesChanged: string[] }): string {
  return [
    "KimiReviewer produced a bugfix during READ-AND-BUGFIX:",
    `summary: ${bugfix.summary}`,
    `filesChanged: ${bugfix.filesChanged.join(", ")}`,
    "diff:",
    bugfix.diff,
  ].join("\n")
}

function toolMessage(toolCallId: string, result: ToolResult): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  }
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
): Promise<FetchOnceResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      return {
        kind: "http",
        status: res.status,
        bodyText: text,
        retryAfter: res.headers.get("retry-after") ?? undefined,
      }
    }
    let payload: OpenAIResponse
    try {
      payload = JSON.parse(text) as OpenAIResponse
    } catch {
      return { kind: "http", status: 502, bodyText: "Moonshot returned non-JSON envelope", retryAfter: undefined }
    }
    return { kind: "payload", payload }
  } catch (err) {
    return { kind: "network", message: describeError(err) }
  } finally {
    clearTimeout(timer)
  }
}

type FetchOnceResult =
  | { kind: "payload"; payload: OpenAIResponse }
  | { kind: "http"; status: number; bodyText: string; retryAfter: string | undefined }
  | { kind: "network"; message: string }

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted/i.test(err.message)) return "request timed out"
    return err.message
  }
  return String(err)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function stripFences(content: string): string {
  if (content.startsWith("```")) {
    const m = content.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
    if (m) return m[1]
  }
  return content
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
