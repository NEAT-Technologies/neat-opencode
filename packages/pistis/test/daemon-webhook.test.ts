import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { deliverWebhook } from "../src/daemon/webhook"

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function makeStubFetch(responses: Array<{ status?: number; throws?: Error }>) {
  const calls: Recorded[] = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const initHeaders = init?.headers
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => { headers[k] = v })
    } else if (initHeaders && typeof initHeaders === "object") {
      for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) headers[k] = v
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: String(init?.body ?? ""),
    })
    const slot = responses[Math.min(i, responses.length - 1)]
    i++
    if (slot.throws) throw slot.throws
    return new Response("", { status: slot.status ?? 200 })
  }
  const fetchImpl = fn as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("deliverWebhook", () => {
  test("Test 12: POSTs JSON with correct signature header", async () => {
    const { fetchImpl, calls } = makeStubFetch([{ status: 200 }])
    const result = await deliverWebhook(
      { url: "http://x/hook", secret: "shh", fetchImpl },
      "run-1",
      '{"runId":"run-1","verdict":"accepted"}',
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers["X-Pistis-Run-Id"] ?? calls[0].headers["x-pistis-run-id"]).toBe("run-1")
    const sig = calls[0].headers["X-Pistis-Signature"] ?? calls[0].headers["x-pistis-signature"]
    const expectedSig = "sha256=" + createHmac("sha256", "shh").update(calls[0].body, "utf8").digest("hex")
    expect(sig).toBe(expectedSig)
  })

  test("Test 13: 5xx → ok=false, error captured", async () => {
    const { fetchImpl } = makeStubFetch([{ status: 503 }])
    const result = await deliverWebhook(
      { url: "http://x/hook", secret: "shh", fetchImpl },
      "run-1",
      "{}",
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.error).toMatch(/503/)
  })

  test("network error → ok=false, never throws", async () => {
    const { fetchImpl } = makeStubFetch([{ throws: new Error("ECONNRESET") }])
    const result = await deliverWebhook(
      { url: "http://x/hook", secret: "shh", fetchImpl },
      "run-1",
      "{}",
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ECONNRESET/)
  })
})
