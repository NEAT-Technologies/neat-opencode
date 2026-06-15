import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { StubWorker } from "../src/opencode/stub-worker"
import { OpenCodeWorker } from "../src/opencode/opencode-worker"
import { WorkerNotImplementedError } from "../src/opencode/worker"
import type { AgentContract } from "../src/contract/types"

function contract(allowedFiles: string[] = ["src/a.ts"]): AgentContract {
  return {
    contractId: "INC-X::patch::000",
    agentRole: "patch",
    objective: "x",
    graphContext: {},
    allowedFiles,
    forbiddenFiles: [],
    constraints: [],
    successCriteria: [],
    requiredOutputs: ["patch.diff"],
    validationCommands: [],
    maxRetries: 2,
  }
}

describe("StubWorker", () => {
  test("touches existing allowedFiles in place (no fallback when allowedFiles modified)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      await fs.mkdir(join(dir, "src"), { recursive: true })
      await fs.writeFile(join(dir, "src/a.ts"), "// initial\n")
      const w = new StubWorker()
      const r = await w.run(contract(["src/a.ts"]), { cwd: dir, isGitRepo: false })
      expect(r.status).toBe("completed")
      expect(r.filesChanged).toEqual(["src/a.ts"])
      const note = await fs.readFile(join(dir, "src/a.ts"), "utf8")
      expect(note).toContain("PISTIS_NOTE")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("writes PISTIS_PROPOSED_FIX.md fallback when no allowedFiles exist on disk", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      const w = new StubWorker()
      const r = await w.run(contract([]), { cwd: dir, isGitRepo: false })
      expect(r.filesChanged).toEqual(["PISTIS_PROPOSED_FIX.md"])
      const fix = await fs.readFile(join(dir, "PISTIS_PROPOSED_FIX.md"), "utf8")
      expect(fix).toContain("INC-X::patch::000")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("failMode='no_changes' returns no files changed", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      const w = new StubWorker({ failMode: "no_changes" })
      const r = await w.run(contract([]), { cwd: dir, isGitRepo: false })
      expect(r.filesChanged.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("failMode='out_of_scope' writes a file outside allowedFiles", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      const w = new StubWorker({ failMode: "out_of_scope" })
      const r = await w.run(contract(["src/a.ts"]), { cwd: dir, isGitRepo: false })
      expect(r.filesChanged).toContain("PISTIS_OUT_OF_SCOPE.md")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("failMode='blocked' returns status=blocked", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      const w = new StubWorker({ failMode: "blocked" })
      const r = await w.run(contract([]), { cwd: dir, isGitRepo: false })
      expect(r.status).toBe("blocked")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("respects forbiddenFiles even when in allowedFiles (defense-in-depth)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-stub-"))
    try {
      await fs.mkdir(join(dir, "src"), { recursive: true })
      await fs.writeFile(join(dir, "src/a.ts"), "// initial\n")
      const w = new StubWorker()
      const ctr = contract(["src/a.ts"])
      ctr.forbiddenFiles = ["src/a.ts"]
      const r = await w.run(ctr, { cwd: dir, isGitRepo: false })
      expect(r.filesChanged).not.toContain("src/a.ts")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("OpenCodeWorker", () => {
  test("throws WorkerNotImplementedError until wired", async () => {
    const w = new OpenCodeWorker()
    await expect(w.run(contract(), { cwd: "/tmp", isGitRepo: false })).rejects.toBeInstanceOf(WorkerNotImplementedError)
  })
})
