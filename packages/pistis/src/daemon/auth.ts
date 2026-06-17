import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Constant-time Bearer token validation.
 *
 * `crypto.timingSafeEqual` requires equal-length inputs and throws otherwise.
 * The caller-supplied token can be any length, and length-padding leaks the
 * expected length. Strategy: SHA-256 both tokens (always 32 bytes) and compare
 * the digests. Both digests are the same length, the comparison is genuinely
 * constant-time, and the expected token's length is not observable.
 */
export function tokenMatches(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest()
  const providedDigest = createHash("sha256").update(provided, "utf8").digest()
  return timingSafeEqual(expectedDigest, providedDigest)
}

/**
 * Extract the bearer token from an Authorization header. Returns undefined
 * when the header is missing or malformed.
 */
export function parseBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  return match ? match[1] : undefined
}

/**
 * Top-level auth gate. Returns true iff the request carries the expected token.
 * No timing oracle: SHA-256 comparison is performed even when the header is
 * missing (against a fixed dummy string) so failure paths take the same time.
 */
export function isAuthorized(expectedToken: string, req: Request): boolean {
  const provided = parseBearer(req.headers.get("authorization")) ?? ""
  return tokenMatches(expectedToken, provided)
}
