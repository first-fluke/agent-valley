import { execFile } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { copyOnWriteClone, seedWorkspaceCaches, siblingMissionWorkspaces, workspaceCachePaths } from "./workspace-cache"

const exec = promisify(execFile)
const copy = vi.fn((source: string, destination: string) => cp(source, destination, { recursive: true }))
let directory: string
let workspace: string
let source: string

async function repository(path: string, ignore: string) {
  await mkdir(path, { recursive: true })
  await exec("git", ["init", "-q", path])
  await writeFile(join(path, ".gitignore"), ignore)
}
async function cache(root: string, path: string, content: string) {
  await mkdir(join(root, path, "deps"), { recursive: true })
  await writeFile(join(root, path, "deps", "artifact"), content)
}
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-workspace-cache-"))
  workspace = join(directory, "task")
  source = join(directory, "mission")
  await repository(workspace, "/target/\n")
  await mkdir(source)
  copy.mockClear()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
})

describe("workspace cache paths", () => {
  it("seeds Cargo debug and release output by default and nothing for other projects", async () => {
    expect(await workspaceCachePaths(workspace, undefined)).toEqual([])
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    expect(await workspaceCachePaths(workspace, undefined)).toEqual(["target/debug", "target/release"])
  })

  it("honors an explicit list, drops unsafe entries and can be switched off", async () => {
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    expect(await workspaceCachePaths(workspace, "off")).toEqual([])
    expect(await workspaceCachePaths(workspace, " ")).toEqual([])
    expect(
      await workspaceCachePaths(workspace, "build/, ../outside,/abs,.git/objects,.agent-valley/x,dist,dist"),
    ).toEqual(["build", "dist"])
  })
})

describe("workspace cache seeding", () => {
  it("clones an ignored cache from the first source that has it", async () => {
    const previous = join(directory, "previous-attempt")
    await cache(previous, "target/debug", "from previous attempt")
    await cache(source, "target/debug", "from mission")
    const seeded = await seedWorkspaceCaches({
      workspace,
      sources: [join(directory, "missing"), previous, source],
      paths: ["target/debug", "target/release"],
      clone: copy,
    })
    expect(seeded).toEqual([{ path: "target/debug", source: previous }])
    expect(await readFile(join(workspace, "target/debug/deps/artifact"), "utf8")).toBe("from previous attempt")
    expect(await exists(join(workspace, "target/release"))).toBe(false)
    expect((await exec("git", ["status", "--porcelain", "--", "target"], { cwd: workspace })).stdout).toBe("")
  })

  it("never seeds a path Git can see, so a cache cannot become a task delivery", async () => {
    await cache(source, "build", "visible")
    expect(await seedWorkspaceCaches({ workspace, sources: [source], paths: ["build"], clone: copy })).toEqual([])
    expect(copy).not.toHaveBeenCalled()
    expect(await exists(join(workspace, "build"))).toBe(false)
  })

  it("keeps an existing cache and survives a failed clone without leaving a partial tree", async () => {
    await cache(source, "target/debug", "from mission")
    await cache(workspace, "target/debug", "already built")
    expect(await seedWorkspaceCaches({ workspace, sources: [source], paths: ["target/debug"], clone: copy })).toEqual(
      [],
    )
    expect(await readFile(join(workspace, "target/debug/deps/artifact"), "utf8")).toBe("already built")
    await rm(join(workspace, "target"), { recursive: true })
    const failing = vi.fn(async (_source: string, destination: string) => {
      await mkdir(destination, { recursive: true })
      throw new Error("clone unsupported")
    })
    expect(
      await seedWorkspaceCaches({ workspace, sources: [source], paths: ["target/debug"], clone: failing }),
    ).toEqual([])
    expect(failing).toHaveBeenCalledOnce()
    expect(await exists(join(workspace, "target/debug"))).toBe(false)
  })

  it.skipIf(process.platform !== "darwin")("clones a tree copy-on-write with its timestamps", async () => {
    await cache(source, "target/debug", "real clone")
    const stamp = new Date("2026-01-02T03:04:05Z")
    await utimes(join(source, "target/debug/deps/artifact"), stamp, stamp)
    await mkdir(join(workspace, "target"))
    await copyOnWriteClone(join(source, "target/debug"), join(workspace, "target/debug"))
    const cloned = join(workspace, "target/debug/deps/artifact")
    expect(await readFile(cloned, "utf8")).toBe("real clone")
    expect((await lstat(cloned)).mtimeMs).toBe(stamp.getTime())
  })
})

describe("sibling mission workspaces", () => {
  it("lists other recorded mission workspaces newest first", async () => {
    const parent = join(directory, "workspaces")
    for (const [name, at] of [
      ["older", "2026-01-01T00:00:00Z"],
      ["newer", "2026-01-03T00:00:00Z"],
      ["current", "2026-01-04T00:00:00Z"],
    ] as const) {
      await mkdir(join(parent, name, "workspace"), { recursive: true })
      await writeFile(join(parent, name, "workspace.json"), "{}")
      await utimes(join(parent, name, "workspace.json"), new Date(at), new Date(at))
    }
    await mkdir(join(parent, "unrecorded", "workspace"), { recursive: true })
    expect(await siblingMissionWorkspaces(join(parent, "current", "workspace"))).toEqual([
      join(parent, "newer", "workspace"),
      join(parent, "older", "workspace"),
    ])
  })
})
