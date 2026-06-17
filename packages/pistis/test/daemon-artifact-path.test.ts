import { describe, expect, test } from "bun:test"
import { validateArtifactPath, contentTypeFor } from "../src/daemon/artifact-path"

describe("validateArtifactPath", () => {
  test("accepts a flat artifact name", () => {
    expect(validateArtifactPath("final-report.md")).toBe("final-report.md")
  })
  test("accepts nested artifact paths (multi-role layout)", () => {
    expect(validateArtifactPath("patch/001/contract.json")).toBe("patch/001/contract.json")
  })
  test("rejects path traversal via .. segment (this is the regression case)", () => {
    expect(validateArtifactPath("../etc/passwd")).toBeNull()
    expect(validateArtifactPath("a/../b")).toBeNull()
    expect(validateArtifactPath("a/b/..")).toBeNull()
  })
  test("rejects single-dot segments", () => {
    expect(validateArtifactPath("./final.md")).toBeNull()
    expect(validateArtifactPath("a/./b")).toBeNull()
  })
  test("rejects empty segments (double slash)", () => {
    expect(validateArtifactPath("a//b")).toBeNull()
  })
  test("rejects leading slash", () => {
    expect(validateArtifactPath("/etc/passwd")).toBeNull()
  })
  test("rejects characters outside the allowlist", () => {
    expect(validateArtifactPath("file with spaces.md")).toBeNull()
    expect(validateArtifactPath("file;dropdb.md")).toBeNull()
    expect(validateArtifactPath("$(echo).md")).toBeNull()
  })
  test("rejects empty input", () => {
    expect(validateArtifactPath("")).toBeNull()
  })
})

describe("contentTypeFor", () => {
  test("md → text/markdown", () => {
    expect(contentTypeFor("x.md")).toContain("text/markdown")
  })
  test("json → application/json", () => {
    expect(contentTypeFor("x.json")).toContain("application/json")
  })
  test("jsonl → application/json", () => {
    expect(contentTypeFor("tool-calls.jsonl")).toContain("application/json")
  })
  test("diff → text/plain", () => {
    expect(contentTypeFor("patch.diff")).toContain("text/plain")
  })
  test("unknown → octet-stream", () => {
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream")
  })
})
