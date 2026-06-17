import type { RunRecord } from "./run-registry"

export interface ResultSinkInput {
  runId: string
  incidentId: string
  verdict: RunRecord["verdict"] | null
  classification?: string
  startedAt: string
  finishedAt: string
  filesChanged: string[]
  diff?: string
  riskNotes: string[]
  reviewerName?: string
  workerName?: string
  toolCallSummary?: {
    total: number
    unknown: number
    by_tool: Record<string, number>
  }
  artifacts: string[]
}

/**
 * Stable, NEAT-consumable result shape. Written to <runDir>/result.json
 * when an orchestration finishes. This is also the body POSTed to the
 * optional webhook callback.
 */
export function buildResult(input: ResultSinkInput): string {
  return JSON.stringify(input, null, 2) + "\n"
}

/**
 * Summarise tool-calls.jsonl into a compact object suitable for result.json.
 * Returns undefined when no tool-call log exists (no Kimi reviewer in this run).
 */
export function summariseToolCalls(jsonlContent: string | undefined): ResultSinkInput["toolCallSummary"] {
  if (!jsonlContent) return undefined
  const lines = jsonlContent.split("\n").filter((l) => l.trim().length > 0)
  let unknown = 0
  const byTool: Record<string, number> = {}
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { tool?: string; ok?: boolean; error?: string }
      const toolName = typeof parsed.tool === "string" ? parsed.tool : "(unknown)"
      byTool[toolName] = (byTool[toolName] ?? 0) + 1
      if (parsed.ok === false && parsed.error === "unknown_tool") unknown++
    } catch {
      // skip malformed line
    }
  }
  return { total: lines.length, unknown, by_tool: byTool }
}
