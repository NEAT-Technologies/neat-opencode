import { describe, expect, test, beforeEach } from "bun:test"
import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { MinimaxWorker } from "../src/workers/minimax-worker"
import { OutOfRoleError } from "../src/workers/errors"
import { PATCH_SYSTEM_PROMPT, MIGRATION_SYSTEM_PROMPT } from "../src/workers/minimax-prompts"
import type { AgentContract, AgentResult } from "../src/contract/types"

/**
 * MinimaxWorker tests. All HTTP is stubbed. `git apply` is stubbed too —
 * we verify the worker invokes it with the right arguments rather than
 * actually mutating a workspace. Tests are audited against
 * packages/pistis/phases/PHASE_4B_MINIMAX_WORKER.md.
 */

type Recorded = {
  url: string
  method: string
  headers: Record<string, string>
  body: any
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
    })
    const slot = responses[Math.min(i, responses.length - 1)]
    i++
    if (slot.throws) throw slot.throws
    const text = slot.responseText ?? JSON.stringify(slot.json ?? {})
    const headers2 = new Headers()
    if (slot.retryAfter) headers2.set("retry-after", slot.retryAfter)
    return new Response(text, { status: slot.status ?? 200, headers: headers2 })
  }
  const fetchImpl = fn as unknown as typeof fetch
  return { fetchImpl, calls }
}

function makeStubGitApply(results: Array<{ ok: boolean; stderr?: string }>) {
  const calls: Array<{ cwd: string; diff: string }> = []
  let i = 0
  const gitApply = async (cwd: string, diff: string) => {
    calls.push({ cwd, diff })
    const slot = results[Math.min(i, results.length - 1)] ?? { ok: true }
    i++
    return { ok: slot.ok, stderr: slot.stderr ?? "" }
  }
  return { gitApply, calls }
}

function openAIChoice(parsed: unknown, finishReason = "stop"): unknown {
  return {
    id: "x",
    choices: [
      {
        message: { role: "assistant", content: JSON.stringify(parsed) },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

function openAIRawChoice(text: string, finishReason = "stop"): unknown {
  return {
    id: "x",
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
  }
}

const FAKE_KEY = "MINIMAX_TEST_KEY_xxxxxxxxxxxxxxxx"

function contractFor(role: string, overrides: Partial<AgentContract> = {}): AgentContract {
  return {
    contractId: `INC-T::${role}::000`,
    agentRole: role,
    objective: "test objective",
    graphContext: { incident: { id: "INC-T" } },
    allowedFiles: ["src/app.ts"],
    forbiddenFiles: ["**/auth/**", "**/.env*"],
    constraints: [],
    successCriteria: ["the bug is fixed"],
    requiredOutputs: ["a unified diff"],
    validationCommands: [],
    maxRetries: 1,
    ...overrides,
  }
}

const VALID_PATCH_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1,2 @@",
  " hello",
  "+world",
  "",
].join("\n")

const VALID_MIGRATION_DIFF = [
  "diff --git a/migrations/20260617120000_add_soft_delete.sql b/migrations/20260617120000_add_soft_delete.sql",
  "new file mode 100644",
  "index 0000000..0000000",
  "--- /dev/null",
  "+++ b/migrations/20260617120000_add_soft_delete.sql",
  "@@ -0,0 +1,2 @@",
  "+ALTER TABLE customers ADD COLUMN deleted_at TIMESTAMP NULL;",
  "+CREATE INDEX idx_customers_deleted_at ON customers(deleted_at);",
  "",
].join("\n")

const validPatchPayload = {
  summary: "Add world line.",
  diff: VALID_PATCH_DIFF,
  filesChanged: ["src/app.ts"],
  riskNotes: [],
  unresolvedQuestions: [],
}

const validMigrationPayload = {
  summary: "Add soft-delete column to customers.",
  diff: VALID_MIGRATION_DIFF,
  filesChanged: ["migrations/20260617120000_add_soft_delete.sql"],
  riskNotes: [],
  unresolvedQuestions: [],
}

async function makeTmpWorkspace(seed: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pistis-minimax-test-"))
  for (const [rel, content] of Object.entries(seed)) {
    const abs = join(dir, rel)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
  }
  return dir
}

describe("MinimaxWorker", () => {
  beforeEach(() => {
    delete process.env.MINIMAX_API_KEY
    delete process.env.PISTIS_MINIMAX_MODEL
    delete process.env.PISTIS_MINIMAX_BASE_URL
  })

  test("throws on construction without API key", () => {
    expect(() => new MinimaxWorker()).toThrow(/MINIMAX_API_KEY/)
  })

  test("Test 12: throws OutOfRoleError for graph_context", async () => {
    const { fetchImpl } = makeStubFetch([{ json: {} }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    await expect(
      w.run(contractFor("graph_context"), { cwd: "/tmp", isGitRepo: true }),
    ).rejects.toBeInstanceOf(OutOfRoleError)
  })

  test("Test 19: workspace.isGitRepo === false → failed, no API call", async () => {
    const { fetchImpl, calls: fetchCalls } = makeStubFetch([{ json: {} }])
    const { gitApply, calls: applyCalls } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: "/tmp", isGitRepo: false })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/requires a git workspace/i)
    expect(fetchCalls.length).toBe(0)
    expect(applyCalls.length).toBe(0)
  })

  test("Test 1: patch valid response → diff applied, completed AgentResult", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(out.filesChanged).toEqual(["src/app.ts"])
    expect(out.diff).toBe(VALID_PATCH_DIFF)
    expect(calls.length).toBe(1)
    expect(calls[0].diff).toBe(VALID_PATCH_DIFF)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 2: migration valid response → new file path in filesChanged + new file mode in diff", async () => {
    const ws = await makeTmpWorkspace()
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validMigrationPayload) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const contract = contractFor("migration", {
      allowedFiles: ["migrations/20260617120000_add_soft_delete.sql"],
    })
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contract, { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(out.filesChanged).toEqual(["migrations/20260617120000_add_soft_delete.sql"])
    expect(out.diff).toContain("new file mode 100644")
    expect(calls.length).toBe(1)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 3: diff outside allowedFiles → blocked, gitApply not called", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const outsideDiff = VALID_PATCH_DIFF.replace(/src\/app\.ts/g, "src/forbidden.ts")
    const payload = { ...validPatchPayload, diff: outsideDiff, filesChanged: ["src/forbidden.ts"] }
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(payload) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/diff touched disallowed file: src\/forbidden\.ts/)
    expect(out.summary).toMatch(/not_allowed/)
    expect(calls.length).toBe(0)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 4: diff matching forbiddenFiles → blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const forbiddenDiff = VALID_PATCH_DIFF.replace(/src\/app\.ts/g, "src/auth/jwt.ts")
    const payload = { ...validPatchPayload, diff: forbiddenDiff, filesChanged: ["src/auth/jwt.ts"] }
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(payload) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const contract = contractFor("patch", { allowedFiles: ["src/auth/jwt.ts"] })
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contract, { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/forbidden/)
    expect(calls.length).toBe(0)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 5: malformed diff (no diff --git header) → blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const payload = { ...validPatchPayload, diff: "this is not a diff at all\n" }
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(payload) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/unparseable diff/i)
    expect(calls.length).toBe(0)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 6: 401 → blocked, key not echoed", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const errorBody = `{"error":{"message":"invalid Bearer ${FAKE_KEY}"}}`
    const { fetchImpl } = makeStubFetch([{ status: 401, responseText: errorBody }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/auth failed/i)
    expect(out.summary).not.toContain(FAKE_KEY)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 7: finish_reason='length' → failed", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validPatchPayload, "length") }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/truncated/i)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 8: finish_reason='content_filter' → blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validPatchPayload, "content_filter") }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/content_filter/i)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 9: non-JSON content → blocked, first 200 chars preserved", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const garbage = "this is not JSON, just a long apology by the model. ".repeat(10)
    const { fetchImpl } = makeStubFetch([{ json: openAIRawChoice(garbage) }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/non-JSON output/i)
    expect(out.summary.length).toBeLessThan(300)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 9b: fenced JSON content is unwrapped and parsed", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const fenced = "```json\n" + JSON.stringify(validPatchPayload) + "\n```"
    const { fetchImpl } = makeStubFetch([{ json: openAIRawChoice(fenced) }])
    const { gitApply, calls } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(calls.length).toBe(1)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 10: JSON missing diff field → failed", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const payload = { summary: "x", filesChanged: [], riskNotes: [], unresolvedQuestions: [] }
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(payload) }])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/missing field: diff/i)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 11: git apply non-zero → failed, summary contains first stderr line", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([
      { ok: false, stderr: "error: patch does not apply\nadditional context line" },
    ])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/git apply failed:.*does not apply/)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 13: request body shape matches spec", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl, calls } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    const body = calls[0].body
    expect(body.model).toBe("MiniMax-M3")
    expect(body.messages[0].role).toBe("system")
    expect(body.messages[0].content).toBe(PATCH_SYSTEM_PROMPT)
    expect(body.messages[1].role).toBe("user")
    expect(body.response_format.type).toBe("json_object")
    expect(body.temperature).toBe(0.1)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 13 (migration variant): migration system prompt used", async () => {
    const ws = await makeTmpWorkspace()
    const { fetchImpl, calls } = makeStubFetch([{ json: openAIChoice(validMigrationPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const contract = contractFor("migration", {
      allowedFiles: ["migrations/20260617120000_add_soft_delete.sql"],
    })
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    await w.run(contract, { cwd: ws, isGitRepo: true })
    expect(calls[0].body.messages[0].content).toBe(MIGRATION_SYSTEM_PROMPT)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 14: API key in Authorization header, never in URL or body", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl, calls } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(calls[0].url).not.toContain(FAKE_KEY)
    const authHeader = calls[0].headers["authorization"] ?? calls[0].headers["Authorization"]
    expect(authHeader).toBe(`Bearer ${FAKE_KEY}`)
    expect(JSON.stringify(calls[0].body)).not.toContain(FAKE_KEY)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 15: bundled files appear in user message under === FILE: <path> ===", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "FILE_CONTENT_FINGERPRINT_QQQ\n" })
    const { fetchImpl, calls } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    const userMessage = calls[0].body.messages[1].content as string
    expect(userMessage).toContain("=== FILE: src/app.ts ===")
    expect(userMessage).toContain("FILE_CONTENT_FINGERPRINT_QQQ")
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 16: file over per-file byte cap → truncated marker in prompt", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "X".repeat(10_000) })
    const { fetchImpl, calls } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({
      apiKey: FAKE_KEY, fetch: fetchImpl, gitApply,
      perFileByteCap: 1024,
    })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(calls[0].body.messages[1].content as string).toMatch(/<truncated: \d+ bytes>/)
    expect(out.riskNotes.some((n) => /truncated/.test(n))).toBe(true)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 17: total bundle exceeded → failed, no API call", async () => {
    const ws = await makeTmpWorkspace({
      "src/a.ts": "A".repeat(900),
      "src/b.ts": "B".repeat(900),
    })
    const { fetchImpl, calls: fetchCalls } = makeStubFetch([{ json: {} }])
    const { gitApply, calls: applyCalls } = makeStubGitApply([])
    const w = new MinimaxWorker({
      apiKey: FAKE_KEY, fetch: fetchImpl, gitApply,
      fileBundleByteCap: 1024,
      perFileByteCap: 2048,
    })
    const contract = contractFor("patch", { allowedFiles: ["src/a.ts", "src/b.ts"] })
    const out = await w.run(contract, { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("failed")
    expect(out.summary).toMatch(/bundle cap/)
    expect(fetchCalls.length).toBe(0)
    expect(applyCalls.length).toBe(0)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 18: two back-to-back calls produce byte-identical leading prompt segments", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "stable\n" })
    const { fetchImpl, calls } = makeStubFetch([
      { json: openAIChoice(validPatchPayload) },
      { json: openAIChoice(validPatchPayload) },
    ])
    const { gitApply } = makeStubGitApply([{ ok: true }, { ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const contract = contractFor("patch")
    await w.run(contract, { cwd: ws, isGitRepo: true })
    await w.run(contract, { cwd: ws, isGitRepo: true })
    const a = calls[0].body.messages[1].content as string
    const b = calls[1].body.messages[1].content as string
    const aBlocks = a.split("\n\n")
    const bBlocks = b.split("\n\n")
    expect(aBlocks[0]).toBe(bBlocks[0])
    expect(aBlocks[1]).toBe(bBlocks[1])
    expect(aBlocks[0]).toMatch(/^=== INCIDENT ===/)
    expect(aBlocks[1]).toMatch(/^=== GRAPH CONTEXT ===/)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 20: 400 with response_format → retry without response_format succeeds", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const errorBody = `{"error":{"message":"Unsupported field response_format"}}`
    const { fetchImpl, calls } = makeStubFetch([
      { status: 400, responseText: errorBody },
      { json: openAIChoice(validPatchPayload) },
    ])
    const { gitApply, calls: applyCalls } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(calls.length).toBe(2)
    expect(calls[0].body.response_format).toBeDefined()
    expect(calls[1].body.response_format).toBeUndefined()
    expect(applyCalls.length).toBe(1)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("Test 21: truncated file → riskNotes warns the patch may be incomplete", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "Y".repeat(5_000) })
    const { fetchImpl } = makeStubFetch([{ json: openAIChoice(validPatchPayload) }])
    const { gitApply } = makeStubGitApply([{ ok: true }])
    const w = new MinimaxWorker({
      apiKey: FAKE_KEY, fetch: fetchImpl, gitApply,
      perFileByteCap: 1024,
    })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("completed")
    expect(out.riskNotes).toEqual(
      expect.arrayContaining([expect.stringMatching(/truncated; patch may be incomplete/)]),
    )
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("429 → retry then blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([
      { status: 429, responseText: "rl", retryAfter: "0" },
      { status: 429, responseText: "rl", retryAfter: "0" },
    ])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/rate limited/i)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("5xx → retry then blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([
      { status: 503, responseText: "service unavailable" },
      { status: 503, responseText: "service unavailable" },
    ])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/server error: 503/i)
    await fs.rm(ws, { recursive: true, force: true })
  })

  test("network error → retry then blocked", async () => {
    const ws = await makeTmpWorkspace({ "src/app.ts": "hello\n" })
    const { fetchImpl } = makeStubFetch([
      { throws: new Error("ECONNRESET") },
      { throws: new Error("ECONNRESET") },
    ])
    const { gitApply } = makeStubGitApply([])
    const w = new MinimaxWorker({ apiKey: FAKE_KEY, fetch: fetchImpl, gitApply })
    const out = await w.run(contractFor("patch"), { cwd: ws, isGitRepo: true })
    expect(out.status).toBe("blocked")
    expect(out.summary).toMatch(/unreachable/i)
    await fs.rm(ws, { recursive: true, force: true })
  })
})

// helper compatibility: bun:test has expect.arrayContaining via expect, but we need expect.stringMatching too.
// these are imported via the `expect` namespace from bun:test automatically.
function _unused(_x: any): never { throw new Error("unused") }
void _unused
