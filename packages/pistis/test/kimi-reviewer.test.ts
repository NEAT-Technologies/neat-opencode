import { describe, expect, test, beforeEach } from "bun:test"
import { KimiReviewer } from "../src/reviewers/kimi-reviewer"
import { READ_ONLY_TOOLS } from "../src/reviewers/kimi-tools"
import { VERIFY_SYSTEM_PROMPT, BUGFIX_SYSTEM_PROMPT } from "../src/reviewers/kimi-prompts"
import { NeatClient } from "../src/neat/client"
import type { AsyncContractReviewerInput } from "../src/contract/async-reviewer"
import type { AgentContract, AgentResult } from "../src/contract/types"
import type { NormalizedIncident } from "../src/incident/schema"
import type { GraphContext } from "../src/neat/context-builder"

type Recorded = {
  url: string
  method: string
  headers: Record<string, string>
  body: any
  abortSignalTimeAtRequest: number
}

interface StubResponse {
  status?: number
  responseText?: string
  json?: unknown
  retryAfter?: string
  throws?: Error
}

function makeStubFetch(responses: StubResponse[]) {
  const calls: Recorded[] = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
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
      abortSignalTimeAtRequest: Date.now(),
    })
    const slot = responses[Math.min(i, responses.length - 1)]
    i++
    if (slot.throws) throw slot.throws
    const text = slot.responseText ?? JSON.stringify(slot.json ?? {})
    const respHeaders = new Headers()
    if (slot.retryAfter) respHeaders.set("retry-after", slot.retryAfter)
    return new Response(text, { status: slot.status ?? 200, headers: respHeaders })
  }
  const fetchImpl = fn as unknown as typeof fetch
  return { fetchImpl, calls }
}

function makeStubNeatFetch(handlers: Record<string, (req: Request) => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    for (const [key, h] of Object.entries(handlers)) {
      if (url.includes(key)) return h(new Request(url, init as RequestInit))
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
}

function moonshotAssistantContent(json: unknown): StubResponse {
  return {
    json: {
      choices: [
        {
          message: { role: "assistant", content: JSON.stringify(json) },
          finish_reason: "stop",
        },
      ],
    },
  }
}

function moonshotRawContent(text: string, finishReason = "stop"): StubResponse {
  return {
    json: {
      choices: [
        { message: { role: "assistant", content: text }, finish_reason: finishReason },
      ],
    },
  }
}

function moonshotToolCall(toolName: string, args: Record<string, unknown>, id = "call_1"): StubResponse {
  return {
    json: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  }
}

function contractFor(): AgentContract {
  return {
    contractId: "INC-T::patch::000",
    agentRole: "patch",
    objective: "fix the bug",
    graphContext: {},
    allowedFiles: ["src/app.ts"],
    forbiddenFiles: [],
    constraints: [],
    successCriteria: ["the bug is fixed"],
    requiredOutputs: [],
    validationCommands: [],
    maxRetries: 2,
  }
}

function agentResult(diff?: string): AgentResult {
  return {
    contractId: "INC-T::patch::000",
    status: "completed",
    summary: "Add null guard before id access.",
    filesChanged: ["src/app.ts"],
    testsRun: [],
    diff: diff ?? VALID_PATCH_DIFF,
    riskNotes: [],
    unresolvedQuestions: [],
  }
}

const VALID_PATCH_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " const x = customer?.id",
  "+if (!x) throw new Error(\"customer missing\")",
  " console.log(x)",
  "",
].join("\n")

function fakeIncident(): NormalizedIncident {
  return {
    incidentId: "INC-T",
    issueType: "runtime_exception",
    severity: "medium",
    primaryNodeId: "service:order-api",
    message: "TypeError",
    candidateFiles: ["src/app.ts"],
    evidence: [],
    labels: [],
    metadata: {},
  } as unknown as NormalizedIncident
}

function fakeGraphContext(): GraphContext {
  return {
    neat: { baseUrl: "http://stub", healthOk: true },
    primaryNode: { id: "service:order-api", fetched: true },
    incident: { id: "INC-T", issueType: "runtime_exception", severity: "medium", message: "", evidence: [], candidateFiles: [], labels: [] },
    sections: {
      edges: { status: "unavailable", endpoint: "u", error: "n/a" },
      rootCause: { status: "unavailable", endpoint: "u", error: "n/a" },
      blastRadius: { status: "unavailable", endpoint: "u", error: "n/a" },
      dependencies: { status: "unavailable", endpoint: "u", error: "n/a" },
      divergences: { status: "unavailable", endpoint: "u", error: "n/a" },
      incidentsForNode: { status: "unavailable", endpoint: "u", error: "n/a" },
      policyViolations: { status: "unavailable", endpoint: "u", error: "n/a" },
    },
    unavailable: [],
  }
}

function reviewerInput(overrides: Partial<AsyncContractReviewerInput> = {}): AsyncContractReviewerInput {
  return {
    contract: contractFor(),
    result: agentResult(),
    incident: fakeIncident(),
    graphContext: fakeGraphContext(),
    primaryNodeId: "service:order-api",
    ...overrides,
  }
}

function neatStubClient(): NeatClient {
  const fetchImpl = makeStubNeatFetch({
    "/graph/edges/": () =>
      new Response(JSON.stringify({ inbound: [], outbound: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    "/graph/blast-radius/": () =>
      new Response(JSON.stringify({ affectedNodes: ["a"] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    "/graph/node/": () =>
      new Response(JSON.stringify({ node: { id: "svc" } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
  })
  return new NeatClient({ baseUrl: "http://stub.invalid", fetchImpl })
}

const FAKE_KEY = "MOONSHOT_FAKE_KEY_xxxxxxxxxxxxxxxx"

describe("KimiReviewer", () => {
  beforeEach(() => {
    delete process.env.MOONSHOT_API_KEY
    delete process.env.PISTIS_MOONSHOT_MODEL
    delete process.env.PISTIS_MOONSHOT_BASE_URL
    delete process.env.PISTIS_KIMI_TOOL_BUDGET
  })

  test("throws on construction without API key", () => {
    expect(() => new KimiReviewer({ neatClient: neatStubClient() })).toThrow(/MOONSHOT_API_KEY/)
  })

  test("Test 22: AgentResult.diff missing → needs_human, no Moonshot call", async () => {
    const { fetchImpl, calls } = makeStubFetch([{ json: {} }])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput({ result: { ...agentResult(), diff: undefined } as AgentResult }))
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/no diff/i)
    expect(calls.length).toBe(0)
  })

  test("Test 1: verify-only accept (2 tool calls then decision) → accepted, JSONL logged twice", async () => {
    const logged: string[] = []
    const { fetchImpl, calls } = makeStubFetch([
      moonshotToolCall("get_edges", { nodeId: "service:order-api" }, "call_1"),
      moonshotToolCall("get_blast_radius", { nodeId: "service:order-api", depth: 2 }, "call_2"),
      moonshotAssistantContent({
        verdict: "accepted",
        reasons: ["all criteria pass"],
        criteriaResults: [{ criterion: "the bug is fixed", status: "pass", evidence: ["null guard added"] }],
      }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      appendToolCallLog: async (line) => { logged.push(line) },
    })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("accepted")
    expect(out.reasons).toContain("all criteria pass")
    expect(out.criteriaResults.length).toBe(1)
    expect(out.criteriaResults[0].status).toBe("pass")
    expect(logged.length).toBe(2)
    const first = JSON.parse(logged[0])
    expect(first.tool).toBe("get_edges")
    expect(first.ok).toBe(true)
    expect(first.iteration).toBe(1)
    expect(typeof first.result_hash).toBe("string")
    expect(typeof first.latency_ms).toBe("number")
    expect(calls.length).toBe(3)
  })

  test("Test 2: verify-only needs_retry → propagated", async () => {
    const { fetchImpl } = makeStubFetch([
      moonshotAssistantContent({
        verdict: "needs_retry",
        reasons: ["test still red"],
        criteriaResults: [{ criterion: "the bug is fixed", status: "fail", evidence: ["test red"] }],
      }),
    ])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_retry")
    expect(out.nextPrompt).toContain("test still red")
  })

  test("Test 3: verify reject WITHOUT bugfix attempt → rejected, single Moonshot call", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({
        verdict: "rejected",
        reasons: ["critical security risk"],
        criteriaResults: [],
      }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      attemptBugfixOnReject: false,
    })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("rejected")
    expect(out.reasons).toContain("critical security risk")
    expect(calls.length).toBe(1)
  })

  test("Test 4: verify reject WITH bugfix → fresh call with tools=[], returns needs_retry with diff in nextPrompt", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({
        verdict: "rejected",
        reasons: ["missed an edge case"],
        criteriaResults: [],
      }),
      moonshotAssistantContent({
        summary: "Add the edge case guard.",
        diff: VALID_PATCH_DIFF,
        filesChanged: ["src/app.ts"],
        riskNotes: [],
        unresolvedQuestions: [],
      }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      attemptBugfixOnReject: true,
    })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_retry")
    expect(out.nextPrompt).toContain("KimiReviewer produced a bugfix")
    expect(out.nextPrompt).toContain("diff --git a/src/app.ts")
    // bugfix call body has tools = []
    expect(calls[1].body.tools).toEqual([])
    expect(calls[1].body.messages[0].content).toBe(BUGFIX_SYSTEM_PROMPT)
  })

  test("Test 5: iteration cap hit → needs_human", async () => {
    const responses: StubResponse[] = []
    for (let i = 0; i < 20; i++) {
      responses.push(moonshotToolCall("get_edges", { nodeId: "service:order-api" }, `call_${i}`) as StubResponse)
    }
    const { fetchImpl } = makeStubFetch(responses)
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toBe("iteration cap hit")
  })

  test("Test 6: unknown tool name → logged with unknown_tool, NEAT never called for it", async () => {
    let neatCalls = 0
    const neatFetch = makeStubNeatFetch({
      "/": (_req) => { neatCalls++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) },
    })
    const neat = new NeatClient({ baseUrl: "http://stub.invalid", fetchImpl: neatFetch })
    const logged: string[] = []
    const { fetchImpl } = makeStubFetch([
      moonshotToolCall("get_invalid_tool", { nodeId: "service:order-api" }, "call_1"),
      moonshotAssistantContent({
        verdict: "accepted", reasons: [], criteriaResults: [],
      }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neat,
      appendToolCallLog: async (l) => { logged.push(l) },
    })
    await r.review(reviewerInput())
    expect(neatCalls).toBe(0)
    expect(logged.length).toBe(1)
    const parsed = JSON.parse(logged[0])
    expect(parsed.error).toBe("unknown_tool")
    expect(parsed.ok).toBe(false)
  })

  test("Test 7: each tool call writes one JSONL line with required fields", async () => {
    const logged: string[] = []
    const { fetchImpl } = makeStubFetch([
      moonshotToolCall("get_node", { nodeId: "service:order-api" }, "call_1"),
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      appendToolCallLog: async (l) => { logged.push(l) },
    })
    await r.review(reviewerInput())
    expect(logged.length).toBe(1)
    expect(logged[0].endsWith("\n")).toBe(true)
    const parsed = JSON.parse(logged[0])
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.iteration).toBe(1)
    expect(parsed.tool).toBe("get_node")
    expect(parsed.args.nodeId).toBe("service:order-api")
  })

  test("Test 8: identical tool results produce identical result_hash", async () => {
    const logged: string[] = []
    const { fetchImpl } = makeStubFetch([
      moonshotToolCall("get_node", { nodeId: "service:order-api" }, "a"),
      moonshotToolCall("get_node", { nodeId: "service:order-api" }, "b"),
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      appendToolCallLog: async (l) => { logged.push(l) },
    })
    await r.review(reviewerInput())
    const a = JSON.parse(logged[0])
    const b = JSON.parse(logged[1])
    expect(a.result_hash).toBeDefined()
    expect(a.result_hash).toBe(b.result_hash)
  })

  test("Test 9: API key in Authorization header, never in URL", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    await r.review(reviewerInput())
    expect(calls[0].url).not.toContain(FAKE_KEY)
    const auth = calls[0].headers["authorization"] ?? calls[0].headers["Authorization"]
    expect(auth).toBe(`Bearer ${FAKE_KEY}`)
  })

  test("Test 10: 401 → needs_human, key not in reasons", async () => {
    const errorBody = `{"error":{"message":"invalid Bearer ${FAKE_KEY}"}}`
    const { fetchImpl } = makeStubFetch([{ status: 401, responseText: errorBody }])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/auth failed/i)
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY)
  })

  test("Test 11: finish_reason length → needs_human", async () => {
    const { fetchImpl } = makeStubFetch([moonshotRawContent("{partial", "length")])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/truncated/i)
  })

  test("Test 12: finish_reason content_filter → needs_human", async () => {
    const { fetchImpl } = makeStubFetch([moonshotRawContent("nope", "content_filter")])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/content filter/i)
  })

  test("Test 13: non-JSON final message → needs_human with first 200 chars", async () => {
    const garbage = "Sorry I can't decide right now ".repeat(20)
    const { fetchImpl } = makeStubFetch([moonshotRawContent(garbage)])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/not JSON/)
    expect(out.reasons[0].length).toBeLessThan(300)
  })

  test("Test 18: request body shape — verify call has 8 tools + verify system prompt", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    await r.review(reviewerInput())
    const body = calls[0].body
    expect(body.model).toBe("kimi-k2-7-instruct")
    expect(body.messages[0].role).toBe("system")
    expect(body.messages[0].content).toBe(VERIFY_SYSTEM_PROMPT)
    expect(body.tools.length).toBe(8)
    expect(body.tool_choice).toBe("auto")
  })

  test("Test 18 (variant): bugfix call has tools=[] and BUGFIX system prompt", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({ verdict: "rejected", reasons: ["x"], criteriaResults: [] }),
      moonshotAssistantContent({
        summary: "s", diff: VALID_PATCH_DIFF, filesChanged: [], riskNotes: [], unresolvedQuestions: [],
      }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      attemptBugfixOnReject: true,
    })
    await r.review(reviewerInput())
    expect(calls[1].body.tools).toEqual([])
    expect(calls[1].body.messages[0].content).toBe(BUGFIX_SYSTEM_PROMPT)
  })

  test("Test 19: PISTIS_KIMI_TOOL_BUDGET=3 overrides cap", async () => {
    process.env.PISTIS_KIMI_TOOL_BUDGET = "3"
    const responses: StubResponse[] = []
    for (let i = 0; i < 10; i++) {
      responses.push(moonshotToolCall("get_edges", { nodeId: "service:order-api" }, `c_${i}`) as StubResponse)
    }
    const { fetchImpl } = makeStubFetch(responses)
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toBe("iteration cap hit")
  })

  test("Test 20: BUGFIX returns non-JSON → final verdict rejected (never silently accept)", async () => {
    const { fetchImpl } = makeStubFetch([
      moonshotAssistantContent({ verdict: "rejected", reasons: ["original"], criteriaResults: [] }),
      moonshotRawContent("apology, can't produce a fix"),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      attemptBugfixOnReject: true,
    })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("rejected")
    expect(out.reasons).toContain("original")
  })

  test("Test 21: byte-identical leading prompt segments across two reviews of the same input", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const input = reviewerInput()
    await r.review(input)
    await r.review(input)
    const a = calls[0].body.messages[1].content as string
    const b = calls[1].body.messages[1].content as string
    const ab = a.split("\n\n")
    const bb = b.split("\n\n")
    expect(ab[0]).toBe(bb[0])
    expect(ab[1]).toBe(bb[1])
    expect(ab[0]).toMatch(/^=== INCIDENT ===/)
  })

  test("Test 23: bad tool arguments → logged with bad_arguments, error returned to model", async () => {
    const logged: string[] = []
    const { fetchImpl } = makeStubFetch([
      {
        json: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "c", type: "function", function: { name: "get_node", arguments: "not json" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
      moonshotAssistantContent({ verdict: "accepted", reasons: [], criteriaResults: [] }),
    ])
    const r = new KimiReviewer({
      apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient(),
      appendToolCallLog: async (l) => { logged.push(l) },
    })
    await r.review(reviewerInput())
    expect(logged.length).toBe(1)
    const parsed = JSON.parse(logged[0])
    expect(parsed.error).toBe("bad_arguments")
  })

  test("network error → retry then needs_human", async () => {
    const { fetchImpl } = makeStubFetch([
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
    ])
    const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
    const out = await r.review(reviewerInput())
    expect(out.verdict).toBe("needs_human")
    expect(out.reasons[0]).toMatch(/unreachable/i)
  })

  test("invariant: no failure path returns 'accepted'", async () => {
    // run through 5 failure shapes and assert verdict is never accepted
    const failures: StubResponse[][] = [
      [{ status: 401, responseText: "{}" }],
      [{ status: 503, responseText: "{}" }, { status: 503, responseText: "{}" }],
      [moonshotRawContent("nope", "length")],
      [moonshotRawContent("nope", "content_filter")],
      [moonshotRawContent("not json")],
    ]
    for (const responses of failures) {
      const { fetchImpl } = makeStubFetch(responses)
      const r = new KimiReviewer({ apiKey: FAKE_KEY, fetch: fetchImpl, neatClient: neatStubClient() })
      const out = await r.review(reviewerInput())
      expect(out.verdict).not.toBe("accepted")
    }
  })
})
