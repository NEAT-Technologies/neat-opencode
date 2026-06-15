import { describe, expect, test } from "bun:test"
import { ArtifactStore, stableStringify, resolveArtifactRoot } from "../src/artifacts/store"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"

async function freshTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe("ArtifactStore", () => {
  test("creates run dir + writes JSON + text", async () => {
    const root = await freshTmp("pistis-art-")
    try {
      const s = await ArtifactStore.create(root, "INC-1")
      await s.writeJson("incident.json", { a: 1, b: [3, 2, 1] })
      await s.writeText("plan.md", "# hello\n")
      const list = await s.list()
      expect(list.sort()).toEqual(["incident.json", "plan.md"])
      const json = JSON.parse(await fs.readFile(path.join(s.runDir, "incident.json"), "utf8"))
      expect(json).toEqual({ a: 1, b: [3, 2, 1] })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("repeated incident id gets a timestamped suffix", async () => {
    const root = await freshTmp("pistis-art-")
    try {
      const a = await ArtifactStore.create(root, "INC-1")
      const b = await ArtifactStore.create(root, "INC-1")
      expect(a.runDir).not.toBe(b.runDir)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("sanitizes weird incident ids", async () => {
    const root = await freshTmp("pistis-art-")
    try {
      const s = await ArtifactStore.create(root, "INC/../etc/passwd:!?")
      expect(s.runDir.startsWith(root)).toBe(true)
      expect(path.basename(s.runDir)).not.toContain("/")
      expect(path.basename(s.runDir)).not.toContain("..")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("stableStringify sorts object keys deterministically", () => {
    const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })
    const b = stableStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 })
    expect(a).toBe(b)
  })

  test("resolveArtifactRoot prefers explicit, then env, then default", () => {
    const orig = process.env.PISTIS_OUT_DIR
    try {
      delete process.env.PISTIS_OUT_DIR
      expect(resolveArtifactRoot()).toBe(path.resolve(process.cwd(), ".pistis", "runs"))
      process.env.PISTIS_OUT_DIR = "/tmp/from-env"
      expect(resolveArtifactRoot()).toBe(path.resolve("/tmp/from-env"))
      expect(resolveArtifactRoot("/tmp/explicit")).toBe(path.resolve("/tmp/explicit"))
    } finally {
      if (orig === undefined) delete process.env.PISTIS_OUT_DIR
      else process.env.PISTIS_OUT_DIR = orig
    }
  })
})
