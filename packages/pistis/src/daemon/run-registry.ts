export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export interface RunRecord {
  runId: string
  incidentId: string
  status: RunStatus
  startedAt: string
  finishedAt?: string
  verdict?: "accepted" | "rejected" | "needs_retry" | "needs_human"
  classification?: string
  workspaceCwd?: string
  runDir?: string
  artifacts: string[]
  error?: string
}

export interface RunRegistryOptions {
  /** Cap on stored records. Default 1000. */
  max?: number
}

/**
 * In-memory run registry. Bounded; when full, oldest finished runs are evicted
 * first. Running / queued runs are never evicted. State does NOT persist across
 * daemon restarts — artifacts on disk do, but the in-memory view is rebuilt
 * fresh each boot.
 */
export class RunRegistry {
  private readonly records = new Map<string, RunRecord>()
  private readonly insertionOrder: string[] = []
  private readonly max: number

  constructor(opts: RunRegistryOptions = {}) {
    this.max = Math.max(1, opts.max ?? 1000)
  }

  start(runId: string, incidentId: string): RunRecord {
    if (this.records.has(runId)) {
      throw new Error(`duplicate runId: ${runId}`)
    }
    const record: RunRecord = {
      runId,
      incidentId,
      status: "queued",
      startedAt: new Date().toISOString(),
      artifacts: [],
    }
    this.records.set(runId, record)
    this.insertionOrder.push(runId)
    this.evictIfNeeded()
    return record
  }

  setStatus(runId: string, status: RunStatus, partial: Partial<RunRecord> = {}): void {
    const record = this.records.get(runId)
    if (!record) return
    record.status = status
    Object.assign(record, partial)
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    ) {
      record.finishedAt = record.finishedAt ?? new Date().toISOString()
    }
  }

  cancel(runId: string): "cancelling" | "not_found" | "already_finished" {
    const record = this.records.get(runId)
    if (!record) return "not_found"
    if (isTerminal(record.status)) return "already_finished"
    record.status = "cancelled"
    record.finishedAt = new Date().toISOString()
    return "cancelling"
  }

  get(runId: string): RunRecord | undefined {
    return this.records.get(runId)
  }

  list(opts: { limit?: number; status?: RunStatus } = {}): RunRecord[] {
    const limit = opts.limit ?? 100
    const all = [...this.insertionOrder].reverse().map((id) => this.records.get(id)!).filter(Boolean)
    const filtered = opts.status ? all.filter((r) => r.status === opts.status) : all
    return filtered.slice(0, limit)
  }

  size(): number {
    return this.records.size
  }

  private evictIfNeeded(): void {
    while (this.records.size > this.max) {
      let evicted = false
      for (let i = 0; i < this.insertionOrder.length; i++) {
        const id = this.insertionOrder[i]
        const r = this.records.get(id)
        if (r && isTerminal(r.status)) {
          this.records.delete(id)
          this.insertionOrder.splice(i, 1)
          evicted = true
          break
        }
      }
      if (!evicted) return // every remaining record is non-terminal; can't evict
    }
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
}
