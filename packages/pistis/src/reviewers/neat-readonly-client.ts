import type { NeatClient } from "../neat/client"

/**
 * Discriminated tool result. Every method on NeatReadOnlyClient returns one
 * of these — never throws — so Kimi can react to a failed lookup without
 * crashing the loop.
 */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

/**
 * Allowlisted, read-only NEAT wrapper exposed to KimiReviewer's tool loop.
 *
 * This class deliberately exposes only the 8 read-only methods Kimi can call.
 * It has no generic `request`, no `safe`, no transport that could route to
 * a write endpoint. Even if Kimi hallucinates a tool name, there's no method
 * on this class for the hallucinated call to land on.
 *
 * `NeatClient.checkPolicies` is intentionally NOT wrapped — it's a POST that
 * mutates audit state on the NEAT side.
 */
export class NeatReadOnlyClient {
  constructor(private readonly inner: NeatClient) {}

  async getNode(nodeId: string): Promise<ToolResult> {
    return this.guard(() => this.inner.getNode(nodeId))
  }

  async getEdges(nodeId: string): Promise<ToolResult> {
    return this.unwrap(await this.inner.getEdges(nodeId))
  }

  async getBlastRadius(nodeId: string, depth?: number): Promise<ToolResult> {
    return this.unwrap(await this.inner.getBlastRadius(nodeId, depth))
  }

  async getDependencies(nodeId: string, depth?: number): Promise<ToolResult> {
    return this.unwrap(await this.inner.getDependencies(nodeId, depth))
  }

  async getRootCause(nodeId: string, errorId?: string): Promise<ToolResult> {
    return this.unwrap(await this.inner.getRootCause(nodeId, errorId))
  }

  async getDivergences(nodeId?: string): Promise<ToolResult> {
    return this.unwrap(await this.inner.getDivergences(nodeId))
  }

  async listIncidents(limit?: number): Promise<ToolResult> {
    return this.unwrap(await this.inner.listIncidents(limit))
  }

  async getPolicyViolations(opts?: { severity?: string; policyId?: string }): Promise<ToolResult> {
    return this.unwrap(await this.inner.getPolicyViolations(opts))
  }

  /**
   * Wrap a throwing inner call (currently `getNode`) so it returns ToolResult.
   * Kimi never sees an exception from NEAT.
   */
  private async guard(fn: () => Promise<unknown>): Promise<ToolResult> {
    try {
      const data = await fn()
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  }

  /**
   * Translate a NeatResult discriminated union into a ToolResult. They have
   * the same shape but slightly different fields; collapsing the error
   * details keeps Kimi's view simple.
   */
  private unwrap(result: { ok: true; data: unknown } | { ok: false; error: string; status?: number }): ToolResult {
    if (result.ok) return { ok: true, data: result.data }
    return { ok: false, error: result.status !== undefined ? `${result.status}: ${result.error}` : result.error }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
