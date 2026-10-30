import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { prepareMissionDependencies } from "../chief-workspace-dependencies"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "av-dependency-links-"))
  directories.push(root)
  const source = join(root, "source")
  const workspace = join(root, "workspace")
  for (const base of [source, workspace]) {
    await mkdir(join(base, "apps/cli"), { recursive: true })
    await mkdir(join(base, "packages/core"), { recursive: true })
  }
  await writeFile(join(source, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }))
  await mkdir(join(source, "node_modules/@test"), { recursive: true })
  await mkdir(join(source, "node_modules/tool"))
  await writeFile(join(source, "node_modules/tool/identity"), "installed")
  await writeFile(join(source, "packages/core/identity"), "source")
  await writeFile(join(workspace, "packages/core/identity"), "workspace")
  await symlink(join(source, "packages/core"), join(source, "node_modules/@test/core"), "dir")
  return { source, workspace }
}

describe("unattended installed dependency preparation", () => {
  it("uses workspace packages and installed external packages without copying or installing", async () => {
    const { source, workspace } = await fixture()
    await prepareMissionDependencies(source, workspace)
    expect(await readFile(join(workspace, "node_modules/@test/core/identity"), "utf8")).toBe("workspace")
    expect(await readFile(join(workspace, "node_modules/tool/identity"), "utf8")).toBe("installed")
    expect(await realpath(join(workspace, "node_modules/tool"))).toBe(await realpath(join(source, "node_modules/tool")))
    expect(await readFile(join(source, "packages/core/identity"), "utf8")).toBe("source")
    await expect(prepareMissionDependencies(source, workspace)).resolves.toBeUndefined()
  })
  it("preserves separate local tool caches", async () => {
    const { source, workspace } = await fixture()
    await mkdir(join(source, "node_modules/.vite"))
    await mkdir(join(workspace, "node_modules/.vite"), { recursive: true })
    await writeFile(join(workspace, "node_modules/.vite/identity"), "local")
    await prepareMissionDependencies(source, workspace)
    expect(await readFile(join(workspace, "node_modules/.vite/identity"), "utf8")).toBe("local")
  })
  it("retains and rejects unexpected installed targets", async () => {
    const { source, workspace } = await fixture()
    await mkdir(join(workspace, "node_modules"))
    await symlink(join(source, "packages/core"), join(workspace, "node_modules/tool"), "dir")
    await expect(prepareMissionDependencies(source, workspace)).rejects.toThrow("differs")
    expect(await realpath(join(workspace, "node_modules/tool"))).toBe(await realpath(join(source, "packages/core")))
  })
  it("refuses package and destination escapes", async () => {
    const { source, workspace } = await fixture()
    await writeFile(join(source, "package.json"), JSON.stringify({ workspaces: ["../outside"] }))
    await expect(prepareMissionDependencies(source, workspace)).rejects.toThrow("relative workspace patterns")
    await writeFile(join(source, "package.json"), "{}")
    await symlink(join(source, "node_modules"), join(workspace, "node_modules"), "dir")
    await expect(prepareMissionDependencies(source, workspace)).rejects.toThrow("local directory")
  })
})
