import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { releaseWorkspaceScratch, scratchDirectories, scratchNote } from "./workspace-scratch"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-scratch-"))
  roots.push(root)
  execFileSync("git", ["init", "-q", root])
  await writeFile(join(root, ".gitignore"), "target/\n")
  await mkdir(join(root, "target", "scratch", "old-run", "build"), { recursive: true })
  await mkdir(join(root, "target", "scratch", "new-run"), { recursive: true })
  await mkdir(join(root, "target", "debug"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "target", "scratch", "old-run", "build", "object"), "x")
  await writeFile(join(root, "target", "debug", "cache"), "x")
  await writeFile(join(root, "src", "lib.rs"), "x")
  const old = new Date(Date.now() - 3 * 3_600_000)
  await utimes(join(root, "target", "scratch", "old-run"), old, old)
  await utimes(join(root, "src", "lib.rs"), old, old)
  return root
}

describe("declared workspace scratch", () => {
  it("removes entries of earlier runs from a declared ignored directory and keeps the latest run and caches", async () => {
    const root = await workspace()
    const release = await releaseWorkspaceScratch(root, { AV_WORKSPACE_SCRATCH: "target/scratch" })
    expect(release).toEqual({ cleared: [{ directory: "target/scratch", entries: 1 }], skipped: [] })
    expect(existsSync(join(root, "target", "scratch", "old-run"))).toBe(false)
    expect(existsSync(join(root, "target", "scratch", "new-run"))).toBe(true)
    expect(existsSync(join(root, "target", "debug", "cache"))).toBe(true)
    expect(scratchNote(release)).toBe("Storage: AV cleared 1 entries of earlier runs from target/scratch.")
  })

  it("refuses tracked or untracked product directories, paths outside the workspace and symbolic links", async () => {
    const root = await workspace()
    await symlink(join(root, "src"), join(root, "target", "link"))
    const release = await releaseWorkspaceScratch(root, {
      AV_WORKSPACE_SCRATCH: "src, ../elsewhere, /tmp, .git, target/link, target/missing",
    })
    expect(release.cleared).toEqual([])
    expect(release.skipped.map((entry) => entry.directory)).toEqual([
      "src",
      "../elsewhere",
      "/tmp",
      ".git",
      "target/link",
    ])
    expect(existsSync(join(root, "src", "lib.rs"))).toBe(true)
    expect(scratchNote(release)).toContain("AV_WORKSPACE_SCRATCH entry src was not cleared")
  })

  it("does nothing without a declaration and honours the age bound", async () => {
    const root = await workspace()
    expect(await releaseWorkspaceScratch(root, {})).toEqual({ cleared: [], skipped: [] })
    expect(scratchNote({ cleared: [], skipped: [] })).toBeUndefined()
    expect(scratchDirectories({ AV_WORKSPACE_SCRATCH: "a, b\na" })).toEqual(["a", "b"])
    const release = await releaseWorkspaceScratch(root, {
      AV_WORKSPACE_SCRATCH: "target/scratch",
      AV_WORKSPACE_SCRATCH_MINUTES: "0",
    })
    expect(release.cleared).toEqual([{ directory: "target/scratch", entries: 2 }])
  })
})
