/**
 * Minimal unified-diff parser. Extracts the files touched by a git-style
 * unified diff and classifies each entry as a modification, new file, or
 * deletion. Used by MinimaxWorker to validate that a returned diff stays
 * within the contract's allowedFiles before any `git apply` runs.
 *
 * Intentionally minimal — does not produce hunks, does not validate line
 * arithmetic. Just extracts paths and new-file flags.
 */

export type DiffEntryKind = "modify" | "new_file" | "delete"

export interface DiffEntry {
  /** Path under workspace root, normalised through posix.normalize. */
  path: string
  kind: DiffEntryKind
}

export interface ParsedDiff {
  entries: DiffEntry[]
}

export class DiffParseError extends Error {
  override readonly name = "DiffParseError"
}

/**
 * Parse a git-style unified diff. Each entry begins with `diff --git`.
 * Throws `DiffParseError` if no entries are found or any entry's headers
 * are malformed.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n")
  const entries: DiffEntry[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.startsWith("diff --git ")) {
      i++
      continue
    }
    const headerMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (!headerMatch) {
      throw new DiffParseError(`malformed diff --git header: ${line}`)
    }
    const aPath = headerMatch[1]
    const bPath = headerMatch[2]

    let kind: DiffEntryKind = "modify"
    let sawMinusMinus = false
    let sawPlusPlus = false
    let entryPath = bPath

    let j = i + 1
    while (j < lines.length && !lines[j].startsWith("diff --git ")) {
      const l = lines[j]
      if (l.startsWith("new file mode")) kind = "new_file"
      else if (l.startsWith("deleted file mode")) kind = "delete"
      else if (l.startsWith("--- ")) {
        sawMinusMinus = true
        if (kind === "new_file" && l !== "--- /dev/null") {
          throw new DiffParseError(`new_file entry expects '--- /dev/null', got '${l}'`)
        }
      } else if (l.startsWith("+++ ")) {
        sawPlusPlus = true
        if (kind === "delete") {
          if (l !== "+++ /dev/null") {
            throw new DiffParseError(`delete entry expects '+++ /dev/null', got '${l}'`)
          }
          entryPath = aPath
        } else {
          const m = l.match(/^\+\+\+ b\/(.+)$/)
          if (!m) throw new DiffParseError(`malformed +++ line: ${l}`)
          if (m[1] !== bPath) {
            throw new DiffParseError(`+++ path '${m[1]}' does not match diff --git b/${bPath}`)
          }
          entryPath = m[1]
        }
      }
      j++
    }

    if (!sawMinusMinus || !sawPlusPlus) {
      throw new DiffParseError(`diff entry for ${entryPath} missing --- or +++ line`)
    }
    if (aPath !== bPath && kind === "modify") {
      throw new DiffParseError(`rename without explicit rename markers: a/${aPath} -> b/${bPath}`)
    }

    entries.push({ path: normalisePosix(entryPath), kind })
    i = j
  }

  if (entries.length === 0) {
    throw new DiffParseError("no `diff --git` entries found in input")
  }
  return { entries }
}

/**
 * Validate that every path in the diff stays inside allowedFiles AND outside
 * forbiddenFiles. Globs in forbiddenFiles are matched via a simple POSIX glob
 * (supports `**`, `*`, `?`).
 *
 * Returns `null` on success, or the offending path on failure.
 */
export function validateDiffPaths(
  parsed: ParsedDiff,
  allowedFiles: string[],
  forbiddenFiles: string[],
): { offending: string; reason: "not_allowed" | "forbidden" | "escapes_workspace" } | null {
  const allowedSet = new Set(allowedFiles.map(normalisePosix))
  for (const entry of parsed.entries) {
    if (entry.path.includes("..") || entry.path.startsWith("/")) {
      return { offending: entry.path, reason: "escapes_workspace" }
    }
    if (!allowedSet.has(entry.path)) {
      return { offending: entry.path, reason: "not_allowed" }
    }
    for (const pattern of forbiddenFiles) {
      if (matchesGlob(entry.path, pattern)) {
        return { offending: entry.path, reason: "forbidden" }
      }
    }
  }
  return null
}

function normalisePosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/")
}

/**
 * Tiny glob matcher: `**` matches any segments, `*` matches within a segment,
 * `?` matches a single non-slash character. Anchored at both ends.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern)
  return re.test(path)
}

function globToRegExp(pattern: string): RegExp {
  let re = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*"
      i += 2
      if (pattern[i] === "/") i++
    } else if (ch === "*") {
      re += "[^/]*"
      i++
    } else if (ch === "?") {
      re += "[^/]"
      i++
    } else if (".+^$|()[]{}\\".includes(ch)) {
      re += `\\${ch}`
      i++
    } else {
      re += ch
      i++
    }
  }
  return new RegExp(`^${re}$`)
}
