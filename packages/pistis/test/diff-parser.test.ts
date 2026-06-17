import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff, validateDiffPaths, DiffParseError, matchesGlob } from "../src/workers/diff-parser"

describe("parseUnifiedDiff", () => {
  test("parses a modify entry", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " hello",
      "+world",
      " end",
      "",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    expect(out.entries).toEqual([{ path: "src/a.ts", kind: "modify" }])
  })

  test("parses a new_file entry", () => {
    const diff = [
      "diff --git a/migrations/0001.sql b/migrations/0001.sql",
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      "+++ b/migrations/0001.sql",
      "@@ -0,0 +1,3 @@",
      "+BEGIN;",
      "+SELECT 1;",
      "+COMMIT;",
      "",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    expect(out.entries).toEqual([{ path: "migrations/0001.sql", kind: "new_file" }])
  })

  test("parses a delete entry", () => {
    const diff = [
      "diff --git a/dead.txt b/dead.txt",
      "deleted file mode 100644",
      "--- a/dead.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-bye",
      "-gone",
      "",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    expect(out.entries).toEqual([{ path: "dead.txt", kind: "delete" }])
  })

  test("parses multiple entries", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1,2 @@",
      " x",
      "+y",
      "",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    expect(out.entries.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("throws on missing --- line", () => {
    const diff = "diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+z\n"
    expect(() => parseUnifiedDiff(diff)).toThrow(DiffParseError)
  })

  test("throws when no diff entries are found", () => {
    expect(() => parseUnifiedDiff("not a diff at all\n")).toThrow(DiffParseError)
  })

  test("throws on +++ path mismatching diff --git header", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/OTHER.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n")
    expect(() => parseUnifiedDiff(diff)).toThrow(DiffParseError)
  })

  test("normalises backslash paths to posix", () => {
    const diff = [
      "diff --git a/src\\a.ts b/src\\a.ts",
      "--- a/src\\a.ts",
      "+++ b/src\\a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    expect(out.entries[0].path).toBe("src/a.ts")
  })
})

describe("validateDiffPaths", () => {
  test("returns null when every path is in allowedFiles and none in forbidden", () => {
    const parsed = { entries: [{ path: "src/a.ts", kind: "modify" as const }] }
    expect(validateDiffPaths(parsed, ["src/a.ts"], [])).toBe(null)
  })

  test("flags a path not in allowedFiles", () => {
    const parsed = { entries: [{ path: "src/b.ts", kind: "modify" as const }] }
    const r = validateDiffPaths(parsed, ["src/a.ts"], [])
    expect(r?.offending).toBe("src/b.ts")
    expect(r?.reason).toBe("not_allowed")
  })

  test("flags a path matching a forbidden glob", () => {
    const parsed = { entries: [{ path: "src/auth/jwt.ts", kind: "modify" as const }] }
    const r = validateDiffPaths(parsed, ["src/auth/jwt.ts"], ["**/auth/**"])
    expect(r?.offending).toBe("src/auth/jwt.ts")
    expect(r?.reason).toBe("forbidden")
  })

  test("flags a path escaping workspace via ..", () => {
    const parsed = { entries: [{ path: "../etc/passwd", kind: "modify" as const }] }
    const r = validateDiffPaths(parsed, ["../etc/passwd"], [])
    expect(r?.reason).toBe("escapes_workspace")
  })

  test("flags absolute paths", () => {
    const parsed = { entries: [{ path: "/etc/passwd", kind: "modify" as const }] }
    const r = validateDiffPaths(parsed, ["/etc/passwd"], [])
    expect(r?.reason).toBe("escapes_workspace")
  })
})

describe("matchesGlob", () => {
  test("** matches across segments", () => {
    expect(matchesGlob("a/b/c.ts", "**/c.ts")).toBe(true)
    expect(matchesGlob("a/b/c.ts", "a/**/c.ts")).toBe(true)
    expect(matchesGlob("a/b/c.ts", "**")).toBe(true)
  })

  test("* matches within a segment, not across", () => {
    expect(matchesGlob("auth.ts", "*.ts")).toBe(true)
    expect(matchesGlob("src/auth.ts", "*.ts")).toBe(false)
  })

  test("escaping dots", () => {
    expect(matchesGlob("a.b.c", "*.b.c")).toBe(true)
    expect(matchesGlob("axb.c", "*.b.c")).toBe(false)
  })
})
