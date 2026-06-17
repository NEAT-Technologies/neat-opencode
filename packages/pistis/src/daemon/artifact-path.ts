/**
 * Two-stage artifact path validation.
 *
 *   1. Regex: only printable ASCII alphanumerics, dot, dash, underscore, and
 *      forward slash as a segment separator.
 *   2. Explicit `..` segment check: rejects any segment equal exactly to "..".
 *      The regex alone allows ".." because "." and "_" are inside the class.
 *
 * Returns the normalised relative path on success, or null on rejection.
 */
const ARTIFACT_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export function validateArtifactPath(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return null
  if (!ARTIFACT_PATH_RE.test(name)) return null
  const segments = name.split("/")
  for (const seg of segments) {
    if (seg === "..") return null
    if (seg === ".") return null
    if (seg.length === 0) return null
  }
  return name
}

/**
 * Content-Type for a known artifact extension. Returns "application/octet-stream"
 * when unknown so the file is always served, never refused.
 */
export function contentTypeFor(name: string): string {
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8"
  if (name.endsWith(".json") || name.endsWith(".jsonl")) return "application/json; charset=utf-8"
  if (name.endsWith(".txt") || name.endsWith(".log")) return "text/plain; charset=utf-8"
  if (name.endsWith(".diff") || name.endsWith(".patch")) return "text/plain; charset=utf-8"
  return "application/octet-stream"
}
