import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

/**
 * Pistis artifact store.
 *
 * Lays out:
 *   <root>/<incidentId>[-<suffix>]/
 *     incident.json
 *     graph-context.json
 *     plan.md
 *     validation.json
 *     dispatch-request.json
 *     final-report.md
 *
 * Each file is written atomically when reasonable: write to a temp file in
 * the same directory, fsync, then rename. Atomic rename is the cheapest
 * guarantee against half-written artifacts if a run is killed mid-write.
 */
export class ArtifactStore {
  private constructor(public readonly runDir: string) {}

  static async create(rootDir: string, incidentId: string): Promise<ArtifactStore> {
    const safeId = sanitizeId(incidentId)
    let runDir = path.join(rootDir, safeId)
    if (await exists(runDir)) {
      const suffix = timestampSuffix()
      runDir = path.join(rootDir, `${safeId}-${suffix}`)
      let counter = 1
      while (await exists(runDir)) {
        runDir = path.join(rootDir, `${safeId}-${suffix}-${counter++}`)
      }
    }
    await fs.mkdir(runDir, { recursive: true })
    return new ArtifactStore(runDir)
  }

  /**
   * Write a UTF-8 text artifact atomically. Returns absolute path.
   *
   * `name` may include slashes for nested artifacts (e.g. `graph_context/001/contract.json`).
   * Parent directories are created on demand. The tmp file is created in the
   * same directory as the target so the rename is atomic.
   */
  async writeText(name: string, content: string): Promise<string> {
    const target = path.join(this.runDir, name)
    const parent = path.dirname(target)
    await fs.mkdir(parent, { recursive: true })
    const tmp = path.join(parent, `.${path.basename(name)}.${process.pid}.${Date.now()}.tmp`)
    const handle = await fs.open(tmp, "w", 0o644)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, target)
    return target
  }

  /** Write a JSON artifact. Pretty-printed with stable key ordering. */
  async writeJson(name: string, value: unknown): Promise<string> {
    return this.writeText(name, stableStringify(value) + "\n")
  }

  /** List artifacts written to the run directory. */
  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.runDir)
    return entries.filter((e) => !e.startsWith(".")).sort()
  }
}

function sanitizeId(id: string): string {
  // Replace anything other than alphanumerics, dot, dash, or underscore. Then
  // strip standalone ".." sequences so an id like "INC/../../x" can never
  // produce a sanitized basename that climbs out of the artifact root.
  const replaced = id.replace(/[^A-Za-z0-9._-]+/g, "_")
  const noDotDot = replaced.replace(/\.{2,}/g, "_")
  const trimmed = noDotDot.replace(/^[._-]+/, "").replace(/[._-]+$/, "")
  return trimmed.slice(0, 200) || "incident"
}

function timestampSuffix(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Stable JSON serializer — sorts object keys recursively. Arrays preserve
 * order. Skips functions / undefined. Used so artifact JSON is byte-stable
 * for tests + content-addressable storage in Phase 2.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => stableReplacer(v), 2)
}

function stableReplacer(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = (value as Record<string, unknown>)[k]
  }
  return out
}

/**
 * Resolve the default artifact root (CLI option, env var, or `.pistis/runs`).
 */
export function resolveArtifactRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit)
  const fromEnv = process.env.PISTIS_OUT_DIR
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), ".pistis", "runs")
}

/**
 * Standalone helper used by the dispatcher to create an artifact writer that
 * writes through `ArtifactStore` without exposing the store directly.
 */
export function artifactWriter(store: ArtifactStore) {
  return async (name: string, content: string) => store.writeText(name, content)
}

/** OS temp dir helper used by tests. */
export function tmpRoot(): string {
  return os.tmpdir()
}
