/**
 * Thin REST client for NEAT Core.
 *
 * Pistis treats NEAT as an external read-only source of truth. This client uses
 * native `fetch` (Bun + Node 20+), supports bearer auth via NEAT_AUTH_TOKEN, and
 * supports project-scoped routing via NEAT's `/projects/:project/...` dual-mount.
 *
 * NEAT package imports are intentionally avoided — Pistis does not depend on
 * NEAT Core at the package level.
 */

export interface NeatClientOptions {
  baseUrl: string
  authToken?: string
  project?: string
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number
  /** Optional fetch override (mostly for tests). */
  fetchImpl?: typeof fetch
}

export class NeatHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`NEAT ${path} responded ${status}`)
    this.name = "NeatHttpError"
  }
}

export class NeatNetworkError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`NEAT ${path} request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "NeatNetworkError"
    this.cause = cause
  }
}

/**
 * Discriminated outcome wrapper used by optional endpoints. The context builder
 * never throws on optional sections — it records the failure verbatim so the
 * artifact captures exactly which endpoint was unavailable.
 */
export type NeatResult<T> =
  | { ok: true; data: T; endpoint: string }
  | { ok: false; endpoint: string; status?: number; error: string }

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base
  const p = path.startsWith("/") ? path : `/${path}`
  return `${b}${p}`
}

function buildPath(project: string | undefined, suffix: string): string {
  if (project && project.length > 0) {
    const encoded = encodeURIComponent(project)
    return `/projects/${encoded}${suffix}`
  }
  return suffix
}

function appendQuery(path: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return path
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue
    usp.append(k, String(v))
  }
  const s = usp.toString()
  return s.length > 0 ? `${path}?${s}` : path
}

export class NeatClient {
  readonly baseUrl: string
  readonly project?: string
  private readonly authToken?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: NeatClientOptions) {
    this.baseUrl = opts.baseUrl
    this.project = opts.project
    this.authToken = opts.authToken
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /** Build a full URL for a project-scoped suffix (e.g. "/graph/node/foo"). */
  buildUrl(suffix: string, query?: Record<string, string | number | undefined>): string {
    return joinUrl(this.baseUrl, appendQuery(buildPath(this.project, suffix), query))
  }

  /** Build a full URL for a daemon-wide path (no project prefix). */
  buildRootUrl(path: string): string {
    return joinUrl(this.baseUrl, path)
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`
    if (body !== undefined) headers["content-type"] = "application/json"

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new NeatNetworkError(url, err)
    }
    clearTimeout(timer)

    const text = await res.text()
    let parsed: unknown = text
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // not JSON — leave as text
      }
    }

    if (!res.ok) {
      throw new NeatHttpError(res.status, url, parsed)
    }
    return parsed as T
  }

  private async safe<T>(url: string): Promise<NeatResult<T>> {
    try {
      const data = await this.request<T>("GET", url)
      return { ok: true, data, endpoint: url }
    } catch (err) {
      if (err instanceof NeatHttpError) {
        return { ok: false, endpoint: url, status: err.status, error: errorMessage(err.body) }
      }
      if (err instanceof NeatNetworkError) {
        return { ok: false, endpoint: url, error: err.message }
      }
      return { ok: false, endpoint: url, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // --- Required-ish ---

  /**
   * Daemon-wide health. Always at the root mount, never project-scoped.
   * Throws on failure — callers treat a dead daemon as fatal.
   */
  async health(): Promise<unknown> {
    return this.request("GET", this.buildRootUrl("/health"))
  }

  /**
   * Primary node lookup. Throws on failure — the rest of the run depends on it.
   */
  async getNode(nodeId: string): Promise<unknown> {
    return this.request("GET", this.buildUrl(`/graph/node/${encodeURIComponent(nodeId)}`))
  }

  // --- Optional (soft-failing) ---

  getEdges(nodeId: string): Promise<NeatResult<unknown>> {
    return this.safe(this.buildUrl(`/graph/edges/${encodeURIComponent(nodeId)}`))
  }

  getRootCause(nodeId: string, errorId?: string): Promise<NeatResult<unknown>> {
    return this.safe(
      this.buildUrl(`/graph/root-cause/${encodeURIComponent(nodeId)}`, errorId ? { errorId } : undefined),
    )
  }

  getBlastRadius(nodeId: string, depth?: number): Promise<NeatResult<unknown>> {
    return this.safe(
      this.buildUrl(`/graph/blast-radius/${encodeURIComponent(nodeId)}`, depth !== undefined ? { depth } : undefined),
    )
  }

  getDependencies(nodeId: string, depth?: number): Promise<NeatResult<unknown>> {
    return this.safe(
      this.buildUrl(`/graph/dependencies/${encodeURIComponent(nodeId)}`, depth !== undefined ? { depth } : undefined),
    )
  }

  getDivergences(node?: string): Promise<NeatResult<unknown>> {
    return this.safe(this.buildUrl(`/graph/divergences`, node ? { node } : undefined))
  }

  listIncidents(limit?: number): Promise<NeatResult<unknown>> {
    return this.safe(this.buildUrl(`/incidents`, limit !== undefined ? { limit } : undefined))
  }

  getIncidentsForNode(nodeId: string): Promise<NeatResult<unknown>> {
    return this.safe(this.buildUrl(`/incidents/${encodeURIComponent(nodeId)}`))
  }

  getPolicyViolations(opts?: { severity?: string; policyId?: string }): Promise<NeatResult<unknown>> {
    return this.safe(this.buildUrl(`/policies/violations`, opts))
  }

  async checkPolicies(hypotheticalAction?: unknown): Promise<NeatResult<unknown>> {
    const url = this.buildUrl(`/policies/check`)
    try {
      const data = await this.request("POST", url, { hypotheticalAction })
      return { ok: true, data, endpoint: url }
    } catch (err) {
      if (err instanceof NeatHttpError) {
        return { ok: false, endpoint: url, status: err.status, error: errorMessage(err.body) }
      }
      if (err instanceof NeatNetworkError) {
        return { ok: false, endpoint: url, error: err.message }
      }
      return { ok: false, endpoint: url, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

function errorMessage(body: unknown): string {
  if (typeof body === "string") return body
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; message?: unknown; details?: unknown }
    if (typeof b.error === "string") return b.error
    if (typeof b.message === "string") return b.message
    if (typeof b.details === "string") return b.details
  }
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/**
 * Resolve a NEAT base URL from CLI option / env / default.
 * Does NOT print the token. Trims trailing slash so URL joining is predictable.
 */
export function resolveNeatBaseUrl(explicit?: string): string {
  const fromEnv = process.env.NEAT_CORE_URL
  const raw = explicit && explicit.length > 0 ? explicit : fromEnv && fromEnv.length > 0 ? fromEnv : "http://localhost:8080"
  return raw.endsWith("/") ? raw.slice(0, -1) : raw
}

export function resolveNeatAuthToken(): string | undefined {
  const t = process.env.NEAT_AUTH_TOKEN
  return t && t.length > 0 ? t : undefined
}

/**
 * Redact a token for logging/artifact safety. Never store the raw token.
 */
export function redactToken(token: string | undefined): string {
  if (!token) return "<none>"
  return "<set:****" + token.slice(Math.max(0, token.length - 2)) + ">"
}
