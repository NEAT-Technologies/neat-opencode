import { createHmac } from "node:crypto"

export interface WebhookConfig {
  url: string
  secret: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface WebhookDeliveryResult {
  ok: boolean
  status?: number
  error?: string
}

/**
 * POST a JSON body to the configured webhook URL with HMAC-SHA256 signature.
 * Single attempt — no retries (NEAT polls /runs/:id as a fallback if delivery
 * fails). 10-second timeout by default. Never throws — returns a discriminated
 * result the daemon can log.
 */
export async function deliverWebhook(
  cfg: WebhookConfig,
  runId: string,
  bodyJson: string,
): Promise<WebhookDeliveryResult> {
  const signature = "sha256=" + createHmac("sha256", cfg.secret).update(bodyJson, "utf8").digest("hex")
  const fetchImpl = cfg.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000)
  try {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pistis-Run-Id": runId,
        "X-Pistis-Signature": signature,
      },
      body: bodyJson,
      signal: controller.signal,
    })
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `webhook responded ${res.status}` }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /aborted|timed out/i.test(message) ? "webhook timed out" : message }
  } finally {
    clearTimeout(timer)
  }
}
