import { describe, expect, test, beforeEach } from "bun:test"
import { FlashWorker } from "../src/workers/flash-worker"
import { OutOfRoleError } from "../src/workers/errors"
import {
  GRAPH_CONTEXT_SYSTEM_PROMPT,
  ROOT_CAUSE_SYSTEM_PROMPT,
  SECURITY_RISK_SYSTEM_PROMPT,
} from "../src/workers/flash-prompts"
import type { AgentContract, AgentResult } from "../src/contract/types"

/**
 * FlashWorker tests. All HTTP is stubbed — no real Gemini calls.
 * Tests are audited against packages/pistis/phases/PHASE_4A_FLASH_WORKER.md.
 */

type Recorded = {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

interface StubOptions {
  status?: number
  responseText?: string
  json?: unknown
  retryAfter?: string
  throws?: Error
}

function makeStubFetch(responses: StubOptions[]) {
  const calls: Recorded[] = []
  let i = 0
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const initHeaders = init?.headers
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => { headers[k] = v })
    } else if (Array.isArray(initHeaders)) {
      for (const [k, v] of initHeaders) headers[k] = v
    } else if (initHeaders && typeof initHeaders === "object") {
      for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) headers[k] = v
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const slot = responses[Math.min(i, responses.length - 1)]
    i++
    if (slot.throws) throw slot.throws
    const responseText = slot.responseText ?? JSON.stringify(slot.json ?? {})
    const responseHeaders = new Headers()
    if (slot.retryAfter) responseHeaders.set("retry-after", slot.retryAfter)
    return new Response(responseText, { status: slot.status ?? 200, headers: responseHeaders })
  }
  // Bun's typeof fetch includes a preconnect method; not used by FlashWorker.
  const fetchImpl = fetchFn as unknown as typeof fetch
  return { fetchImpl, calls }
}

function geminiCandidate(parsedOutput: unknown, finishReason = "STOP"): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(parsedOutput) }] },
        finishReason,
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  }
}

function geminiRawTextCandidate(rawText: string, finishReason = "STOP"): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: rawText }] },
        finishReason,
      },
    ],
  }
}

function fakeIncidentContract(role: string, overrides: Partial<AgentContract> = {}): AgentContract {
  return {
    contractId: `INC-T::${role}::000`,
    agentRole: role,
    objective: "test objective",
    graphContext: {
      incident: { id: "INC-T", issueType: "runtime_exception", primaryNodeId: "svc:x" },
      neat: { baseUrl: "http://x", healthOk: true },
      primaryNode: { id: "svc:x", fetched: true },
      sections: {},
    },
    allowedFiles: [],
    forbiddenFiles: [],
    constraints: [],
    successCriteria: [],
    requiredOutputs: [],
    validationCommands: [],
    maxRetries: 1,
    ...overrides,
  }
}

const FAKE_KEY = "AIzaTESTKEY_DO_NOT_USE_IN_PRODUCTION_xx"

describe("FlashWorker", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY
    delete process.env.PISTIS_FLASH_MODEL
    delete process.env.PISTIS_FLASH_BASE_URL
  })

  test("throws on construction without an API key", () => {
    expect(() => new FlashWorker()).toThrow(/GEMINI_API_KEY/)
  })

  test("reads model + base URL overrides from env", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY
    process.env.PISTIS_FLASH_MODEL = "gemini-3.5-flash-experimental"
    process.env.PISTIS_FLASH_BASE_URL = "https://example.invalid/v1"
    expect(() => new FlashWorker()).not.toThrow()
  })

  test("Test 5: throws OutOfRoleError for patch role", async () => {
    const { fetchImpl, calls } = makeStubFetch([{ json: {} }])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const contract = fakeIncidentContract("patch")
    await expect(w.run(contract, { cwd: "/tmp", isGitRepo: true })).rejects.toBeInstanceOf(OutOfRoleError)
    expect(calls.length).toBe(0)
  })

  test("Test 1: graph_context valid response → completed AgentResult", async () => {
    const summary = "Primary svc:x. Edges fetched. Root-cause hint present. No divergences."
    const { fetchImpl } = makeStubFetch([
      { json: geminiCandidate({ summary, riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(out.summary).toBe(summary)
    expect(out.filesChanged).toEqual([])
    expect(out.testsRun).toEqual([])
  })

  test("Test 2: root_cause prompt body contains graph_context summary", async () => {
    const graphSummary = "GRAPHCTX_FINGERPRINT_12345"
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "rc hypothesis", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const prior: Record<string, AgentResult> = {
      graph_context: {
        contractId: "x", status: "completed", summary: graphSummary,
        filesChanged: [], testsRun: [], riskNotes: [], unresolvedQuestions: [],
      },
    }
    const contract = fakeIncidentContract("root_cause", { inputs: { priorFindings: prior } })
    await w.run(contract, { cwd: "/tmp", isGitRepo: true })
    const promptText = calls[0].body.contents[0].parts[0].text
    expect(promptText).toContain(graphSummary)
  })

  test("Test 3: security_risk without prior patch → blocked", async () => {
    const { fetchImpl, calls } = makeStubFetch([{ json: {} }])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("security_risk"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/security_risk requires a prior patch/i)
    expect(calls.length).toBe(0)
  })

  test("Test 4: security_risk with sensitive patch files → riskNotes preserved", async () => {
    const { fetchImpl } = makeStubFetch([
      {
        json: geminiCandidate({
          summary: "minor concerns",
          riskNotes: ["sensitive path touched: src/auth/jwt.ts"],
          unresolvedQuestions: [],
        }),
      },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const prior: Record<string, AgentResult> = {
      patch: {
        contractId: "x", status: "completed", summary: "ok",
        filesChanged: ["src/auth/jwt.ts"],
        testsRun: [], riskNotes: [], unresolvedQuestions: [],
      },
    }
    const out = await w.run(
      fakeIncidentContract("security_risk", { inputs: { priorFindings: prior } }),
      { cwd: "/tmp", isGitRepo: true },
    )
    expect(out.status).toBe("completed")
    expect(out.riskNotes).toContain("sensitive path touched: src/auth/jwt.ts")
  })

  test("Test 6: 401 → blocked, API key not echoed in summary", async () => {
    const { fetchImpl } = makeStubFetch([{ status: 401, responseText: `{"error":{"code":401,"message":"PERMISSION_DENIED for key ${FAKE_KEY}"}}` }])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/Gemini auth failed/i)
    expect(out.summary).not.toContain(FAKE_KEY)
  })

  test("Test 7: non-JSON response → blocked, first 200 chars preserved", async () => {
    const rawText = "I am not JSON, just a sentence the model wrote anyway. ".repeat(20)
    const { fetchImpl } = makeStubFetch([
      { json: geminiRawTextCandidate(rawText) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/non-JSON output/i)
    expect(out.summary.length).toBeLessThan(300)
  })

  test("Test 8: missing summary field → failed", async () => {
    const { fetchImpl } = makeStubFetch([
      { json: geminiCandidate({ riskNotes: ["lol"], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/missing field: summary/i)
  })

  test("Test 9: finishReason SAFETY → blocked", async () => {
    const { fetchImpl } = makeStubFetch([
      { json: geminiCandidate({ summary: "x", riskNotes: [], unresolvedQuestions: [] }, "SAFETY") },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/safety/i)
  })

  test("Test 10: request body structure matches spec", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "s", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    const body = calls[0].body
    expect(body.systemInstruction.parts[0].text).toBe(GRAPH_CONTEXT_SYSTEM_PROMPT)
    expect(body.generationConfig.responseMimeType).toBe("application/json")
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0)
  })

  test("Test 10 (root_cause variant): thinkingBudget=-1 for root_cause", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "rc", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    await w.run(fakeIncidentContract("root_cause"), { cwd: "/tmp", isGitRepo: true })
    expect(calls[0].body.systemInstruction.parts[0].text).toBe(ROOT_CAUSE_SYSTEM_PROMPT)
    expect(calls[0].body.generationConfig.thinkingConfig.thinkingBudget).toBe(-1)
  })

  test("Test 10 (security_risk variant): correct system prompt", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "ok", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const prior: Record<string, AgentResult> = {
      patch: {
        contractId: "x", status: "completed", summary: "",
        filesChanged: ["src/app.ts"], testsRun: [], riskNotes: [], unresolvedQuestions: [],
      },
    }
    await w.run(
      fakeIncidentContract("security_risk", { inputs: { priorFindings: prior } }),
      { cwd: "/tmp", isGitRepo: true },
    )
    expect(calls[0].body.systemInstruction.parts[0].text).toBe(SECURITY_RISK_SYSTEM_PROMPT)
  })

  test("Test 11: identical inputs produce byte-identical leading prompt segments", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "a", riskNotes: [], unresolvedQuestions: [] }) },
      { json: geminiCandidate({ summary: "b", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const contract = fakeIncidentContract("graph_context")
    await w.run(contract, { cwd: "/tmp", isGitRepo: true })
    await w.run(contract, { cwd: "/tmp", isGitRepo: true })
    const a = calls[0].body.contents[0].parts[0].text as string
    const b = calls[1].body.contents[0].parts[0].text as string
    expect(a).toBe(b)
  })

  test("Test 11 (cross-role variant): graph_context and root_cause share the full stable prefix (incident + graph context blocks)", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "g", riskNotes: [], unresolvedQuestions: [] }) },
      { json: geminiCandidate({ summary: "r", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const gc = fakeIncidentContract("graph_context")
    const rc = fakeIncidentContract("root_cause", { inputs: { priorFindings: {} } })
    await w.run(gc, { cwd: "/tmp", isGitRepo: true })
    await w.run(rc, { cwd: "/tmp", isGitRepo: true })
    const a = calls[0].body.contents[0].parts[0].text as string
    const b = calls[1].body.contents[0].parts[0].text as string
    // Stable prefix is the two blocks "=== INCIDENT ===\n{...}" and "=== GRAPH CONTEXT ===\n{...}",
    // separated by a blank line (\n\n). They must be byte-identical between the two roles —
    // this is what lets Gemini's implicit prefix cache hit in a multi-role run.
    const blocksA = a.split("\n\n")
    const blocksB = b.split("\n\n")
    expect(blocksA[0]).toBe(blocksB[0])
    expect(blocksA[1]).toBe(blocksB[1])
    expect(blocksA[0]).toMatch(/^=== INCIDENT ===/)
    expect(blocksA[1]).toMatch(/^=== GRAPH CONTEXT ===/)
  })

  test("Test 12: 400 with thinkingConfig error → retry without thinkingConfig succeeds", async () => {
    const errorBody = `{"error":{"code":400,"message":"Unknown field thinkingConfig"}}`
    const { fetchImpl, calls } = makeStubFetch([
      { status: 400, responseText: errorBody },
      { json: geminiCandidate({ summary: "ok after fallback", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("root_cause"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(out.summary).toBe("ok after fallback")
    expect(calls.length).toBe(2)
    expect(calls[0].body.generationConfig.thinkingConfig).toBeDefined()
    expect(calls[1].body.generationConfig.thinkingConfig).toBeUndefined()
  })

  test("Test 13: API key sent via x-goog-api-key header, never in URL", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { json: geminiCandidate({ summary: "s", riskNotes: [], unresolvedQuestions: [] }) },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(calls[0].url).not.toContain(FAKE_KEY)
    expect(calls[0].url).not.toContain("key=")
    const headerKey = calls[0].headers["x-goog-api-key"] ?? calls[0].headers["X-Goog-Api-Key"]
    expect(headerKey).toBe(FAKE_KEY)
  })

  test("429 rate limit → retry then blocked", async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 429, responseText: "rate limited", retryAfter: "0" },
      { status: 429, responseText: "still rate limited", retryAfter: "0" },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/rate limited/i)
  })

  test("5xx → retry then blocked with status", async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 502, responseText: "bad gateway" },
      { status: 502, responseText: "bad gateway" },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/server error: 502/i)
  })

  test("network error → retry then blocked", async () => {
    const { fetchImpl } = makeStubFetch([
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
    ])
    const w = new FlashWorker({ apiKey: FAKE_KEY, fetch: fetchImpl })
    const out = await w.run(fakeIncidentContract("graph_context"), { cwd: "/tmp", isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/unreachable/i)
  })
})
