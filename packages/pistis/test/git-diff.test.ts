import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { probeGit, captureDiff } from "../src/opencode/git-diff"

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" })
    child.on("close", (code) => resolve(code ?? -1))
    child.on("error", () => resolve(-1))
  })
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pistis-git-"))
  await run("git", ["init", "-q", "-b", "main"], dir)
  await run("git", ["config", "user.email", "p@p"], dir)
  await run("git", ["config", "user.name", "p"], dir)
  await fs.writeFile(join(dir, "README.md"), "hello\n")
  await run("git", ["add", "README.md"], dir)
  await run("git", ["commit", "-q", "-m", "init"], dir)
  return dir
}

describe("probeGit", () => {
  test("returns false on a non-git directory", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pistis-nongit-"))
    try {
      const p = await probeGit(dir)
      expect(p.isGitRepo).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("returns clean state for a fresh repo", async () => {
    const dir = await initRepo()
    try {
      const p = await probeGit(dir)
      expect(p.isGitRepo).toBe(true)
      expect(p.isCleanWorkingTree).toBe(true)
      expect(p.head).toMatch(/^[0-9a-f]{7,}/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("detects an unclean working tree", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "README.md"), "hello\nchange\n")
      const p = await probeGit(dir)
      expect(p.isCleanWorkingTree).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("captureDiff", () => {
  test("captures a tracked-file modification", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "README.md"), "hello\nworld\n")
      const r = await captureDiff({ cwd: dir })
      expect(r.filesChanged).toEqual(["README.md"])
      expect(r.diff).toContain("--- a/README.md")
      expect(r.diff).toContain("+world")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("includes untracked files when includeUntracked=true", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "NEW.md"), "fresh\n")
      const r = await captureDiff({ cwd: dir, includeUntracked: true })
      expect(r.filesChanged).toContain("NEW.md")
      expect(r.diff).toContain("+++ b/NEW.md")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("excludes untracked files by default", async () => {
    const dir = await initRepo()
    try {
      await fs.writeFile(join(dir, "NEW.md"), "fresh\n")
      const r = await captureDiff({ cwd: dir })
      expect(r.filesChanged).not.toContain("NEW.md")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
