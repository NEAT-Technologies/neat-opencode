import { createHash } from "node:crypto"

/**
 * One JSONL line per Kimi tool call, appended to tool-calls.jsonl in the run
 * dir. Captures what Kimi looked at when forming its verdict — auditable
 * post-hoc, no key material, no diff bodies.
 */
export interface ToolCallLogLine {
  ts: string
  iteration: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** sha256 hex of the JSON-stringified tool result (truncated to 16 chars). */
  result_hash?: string
  latency_ms?: number
  error?: string
}

export type AppendToolCallLog = (line: string) => Promise<void>

export function noopAppendToolCallLog(): AppendToolCallLog {
  return async () => undefined
}

/**
 * Stable JSON-stringify a tool result, then hash. Stable so two identical
 * tool-call results produce identical hashes — useful for de-duplication
 * and for verifying Kimi got the same answer twice.
 */
export function hashToolResult(result: unknown): string {
  const stable = JSON.stringify(result, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v as Record<string, unknown>).sort()
      const out: Record<string, unknown> = {}
      for (const k of keys) out[k] = (v as Record<string, unknown>)[k]
      return out
    }
    return v
  })
  return createHash("sha256").update(stable ?? "").digest("hex").slice(0, 16)
}
