import { execFile } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  copyOnWriteClone,
  operationCacheStore,
  pruneCarriedArtifacts,
  retainWorkspaceCaches,
  seedWorkspaceCaches,
  siblingMissionWorkspaces,
  workspaceCachePaths,
} from "./workspace-cache"

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

  it("skips incremental/ when cloning Cargo profile directories while preserving deps, build, and .fingerprint", async () => {
    await mkdir(join(source, "target/debug/deps"), { recursive: true })
    await mkdir(join(source, "target/debug/build/pkg-123"), { recursive: true })
    await mkdir(join(source, "target/debug/.fingerprint/pkg-123"), { recursive: true })
    await mkdir(join(source, "target/debug/incremental/session-1"), { recursive: true })
    await writeFile(join(source, "target/debug/deps/libserde-0123456789abcdef.rlib"), "dep")
    await writeFile(join(source, "target/debug/build/pkg-123/out"), "build")
    await writeFile(join(source, "target/debug/.fingerprint/pkg-123/invoked.timestamp"), "fp")
    await writeFile(join(source, "target/debug/incremental/session-1/dep-graph.bin"), "stale-incremental")

    const seeded = await seedWorkspaceCaches({
      workspace,
      sources: [source],
      paths: ["target/debug"],
      clone: copy,
      prune: async () => {},
    })
    expect(seeded).toEqual([{ path: "target/debug", source }])
    expect(await readFile(join(workspace, "target/debug/deps/libserde-0123456789abcdef.rlib"), "utf8")).toBe("dep")
    expect(await readFile(join(workspace, "target/debug/build/pkg-123/out"), "utf8")).toBe("build")
    expect(await readFile(join(workspace, "target/debug/.fingerprint/pkg-123/invoked.timestamp"), "utf8")).toBe("fp")
    expect(await exists(join(workspace, "target/debug/incremental"))).toBe(false)
    expect(copy.mock.calls.some(([from]) => from.endsWith("/incremental"))).toBe(false)
  })

  it("strips incremental/ even when handing over an older unpruned build-cache", async () => {
    const store = join(directory, "build-cache")
    await cache(store, "target/debug", "from store")
    await mkdir(join(store, "target/debug/incremental/old-session"), { recursive: true })
    await writeFile(join(store, "target/debug/incremental/old-session/query-cache.bin"), "bloat")

    const seeded = await seedWorkspaceCaches({
      workspace,
      sources: [store],
      paths: ["target/debug"],
      handover: [store],
      clone: copy,
      prune: async () => {},
    })
    expect(seeded).toEqual([{ path: "target/debug", source: store }])
    expect(await readFile(join(workspace, "target/debug/deps/artifact"), "utf8")).toBe("from store")
    expect(await exists(join(workspace, "target/debug/incremental"))).toBe(false)
    expect(copy).not.toHaveBeenCalled()
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

describe("operation build cache", () => {
  it("prunes carried artifacts only after a cache was actually seeded", async () => {
    const prune = vi.fn(async () => {})
    await seedWorkspaceCaches({ workspace, sources: [source], paths: ["target/debug"], clone: copy, prune })
    expect(prune).not.toHaveBeenCalled()
    await cache(source, "target/debug", "from mission")
    await seedWorkspaceCaches({ workspace, sources: [source], paths: ["target/debug"], clone: copy, prune })
    expect(prune).toHaveBeenCalledExactlyOnceWith(workspace)
    const failing = vi.fn(async () => {
      throw new Error("cargo is unavailable")
    })
    await rm(join(workspace, "target"), { recursive: true })
    expect(
      await seedWorkspaceCaches({ workspace, sources: [source], paths: ["target/debug"], clone: copy, prune: failing }),
    ).toEqual([{ path: "target/debug", source }])
  })

  it("moves the cache out of a handover source and clones from every other source", async () => {
    const store = join(directory, "build-cache")
    await cache(store, "target/debug", "from store")
    await cache(source, "target/release", "from mission")
    const seeded = await seedWorkspaceCaches({
      workspace,
      sources: [store, source],
      paths: ["target/debug", "target/release"],
      handover: [store],
      clone: copy,
      prune: async () => {},
    })
    expect(seeded).toEqual([
      { path: "target/debug", source: store },
      { path: "target/release", source },
    ])
    expect(await readFile(join(workspace, "target/debug/deps/artifact"), "utf8")).toBe("from store")
    expect(await exists(join(store, "target/debug"))).toBe(false)
    expect(await readFile(join(source, "target/release/deps/artifact"), "utf8")).toBe("from mission")
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it("prunes incremental/ and stale historical workspace artifacts while preserving third-party dependencies", async () => {
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    const debugDeps = join(workspace, "target/debug/deps")
    const releaseDeps = join(workspace, "target/release/deps")
    const debugExamples = join(workspace, "target/debug/examples")
    await mkdir(join(workspace, "target/debug/incremental/s1"), { recursive: true })
    await mkdir(join(workspace, "target/release/incremental/s2"), { recursive: true })
    await mkdir(debugDeps, { recursive: true })
    await mkdir(releaseDeps, { recursive: true })
    await mkdir(debugExamples, { recursive: true })
    await writeFile(join(workspace, "target/debug/incremental/s1/cache.bin"), "inc")
    await writeFile(join(workspace, "target/release/incremental/s2/cache.bin"), "inc")

    // Stale historical workspace-owned artifacts across multiple hashes
    const staleWorkspaceFiles = [
      join(debugDeps, "arc_daemon-0123456789abcdef"),
      join(debugDeps, "arc_daemon-0123456789abcdef.d"),
      join(debugDeps, "arc_daemon-0123456789abcdef.1a2b3c4d.rcgu.o"),
      join(debugDeps, "libarc_daemon-fedcba9876543210.rlib"),
      join(debugDeps, "libarc_daemon-fedcba9876543210.rmeta"),
      join(debugDeps, "memory_pressure-1111222233334444"),
      join(debugDeps, "memory_pressure-5555666677778888.99aa.rcgu.o"),
      join(releaseDeps, "libarc_core-abcdef0123456789.dylib"),
      join(debugExamples, "demo_bin-0011223344556677"),
    ]
    for (const file of staleWorkspaceFiles) await writeFile(file, "stale")
    await mkdir(join(debugDeps, "arc_daemon-0123456789abcdef.dSYM/Contents"), { recursive: true })
    await writeFile(join(debugDeps, "arc_daemon-0123456789abcdef.dSYM/Contents/Info.plist"), "plist")

    // Third-party dependency artifacts (including prefix-similar names) must be preserved
    const thirdPartyFiles = [
      join(debugDeps, "libserde-0123456789abcdef.rlib"),
      join(debugDeps, "libserde-0123456789abcdef.rmeta"),
      join(debugDeps, "libserde_derive-0123456789abcdef.dylib"),
      join(debugDeps, "libarc_daemon_ext-0123456789abcdef.rlib"),
      join(debugDeps, "libtokio-abcdef0123456789.rlib"),
      join(releaseDeps, "liblibc-1234567890abcdef.rlib"),
      join(debugExamples, "other_example-0011223344556677"),
    ]
    for (const file of thirdPartyFiles) await writeFile(file, "third-party")

    const runCargoClean = vi.fn(async () => {})
    const discoverWorkspaceIdents = vi.fn(
      async () => new Set(["arc_daemon", "arc_core", "memory_pressure", "demo_bin"]),
    )

    await pruneCarriedArtifacts(workspace, { runCargoClean, discoverWorkspaceIdents })

    expect(runCargoClean).toHaveBeenCalledExactlyOnceWith(workspace)
    expect(discoverWorkspaceIdents).toHaveBeenCalledExactlyOnceWith(workspace)
    expect(await exists(join(workspace, "target/debug/incremental"))).toBe(false)
    expect(await exists(join(workspace, "target/release/incremental"))).toBe(false)
    expect(await exists(join(debugDeps, "arc_daemon-0123456789abcdef.dSYM"))).toBe(false)
    for (const file of staleWorkspaceFiles) expect(await exists(file)).toBe(false)
    for (const file of thirdPartyFiles) expect(await exists(file)).toBe(true)
  })

  it("stays fail-safe when cargo clean or cargo metadata fails during pruneCarriedArtifacts", async () => {
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    await mkdir(join(workspace, "target/debug/incremental"), { recursive: true })
    await cache(workspace, "target/debug", "keep-dep")

    await expect(
      pruneCarriedArtifacts(workspace, {
        runCargoClean: async () => {
          throw new Error("cargo clean failed")
        },
        discoverWorkspaceIdents: async () => {
          throw new Error("cargo metadata timed out")
        },
      }),
    ).resolves.toBeUndefined()

    expect(await exists(join(workspace, "target/debug/incremental"))).toBe(false)
    expect(await exists(join(workspace, "target/debug/deps/artifact"))).toBe(true)
  })

  it("prunes Cargo artifacts before retaining workspace caches into the operation cache store", async () => {
    const store = join(directory, "build-cache")
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    await cache(workspace, "target/debug", "latest child")
    await mkdir(join(workspace, "target/debug/incremental/s1"), { recursive: true })
    await writeFile(join(workspace, "target/debug/incremental/s1/cache.bin"), "bloat")

    const events: string[] = []
    const prune = vi.fn(async (dir: string) => {
      events.push(`prune:${dir}`)
      expect(await exists(join(dir, "target/debug"))).toBe(true)
      await rm(join(dir, "target/debug/incremental"), { recursive: true, force: true })
    })

    const retained = await retainWorkspaceCaches(workspace, store, ["target/debug", "target/release"], { prune })
    expect(retained).toEqual(["target/debug"])
    expect(events).toEqual([`prune:${workspace}`])
    expect(await readFile(join(store, "target/debug/deps/artifact"), "utf8")).toBe("latest child")
    expect(await exists(join(store, "target/debug/incremental"))).toBe(false)
    expect(await exists(join(workspace, "target/debug"))).toBe(false)

    // No target directory left to retain: prune is not called again.
    prune.mockClear()
    expect(await retainWorkspaceCaches(workspace, store, ["target/debug"], { prune })).toEqual([])
    expect(prune).not.toHaveBeenCalled()
  })

  it("moves a finished workspace's caches into the store and replaces the previous copy", async () => {
    const store = join(directory, "build-cache")
    await cache(store, "target/debug", "older child")
    await cache(workspace, "target/debug", "latest child")
    expect(await retainWorkspaceCaches(workspace, store, ["target/debug", "target/release"])).toEqual(["target/debug"])
    expect(await readFile(join(store, "target/debug/deps/artifact"), "utf8")).toBe("latest child")
    expect(await exists(join(workspace, "target/debug"))).toBe(false)
    expect(await retainWorkspaceCaches(workspace, store, ["target/debug"])).toEqual([])
    expect(await readFile(join(store, "target/debug/deps/artifact"), "utf8")).toBe("latest child")
  })

  it("names a store only for a recorded operation child workspace", async () => {
    expect(await operationCacheStore(workspace)).toBeUndefined()
    const operation = join(directory, "repository", ".agent-valley", "operations", "operation")
    const container = join(operation, "workspaces", "child")
    await mkdir(join(container, "workspace"), { recursive: true })
    await writeFile(
      join(container, "workspace.json"),
      JSON.stringify({
        operationId: "operation",
        repositoryRoot: join(directory, "repository"),
        missionId: "child",
        baselinePath: join(operation, "baselines", "initial", "workspace"),
        baselineCommit: "a".repeat(40),
        path: join(container, "workspace"),
        branch: "av-operation/operation/child",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    )
    expect(await operationCacheStore(join(container, "workspace"))).toBe(join(operation, "build-cache"))
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

describe("JS/TS workspace cache detection", () => {
  it("detects root and workspace member node_modules alongside Cargo targets", async () => {
    await writeFile(join(workspace, "Cargo.toml"), "[workspace]\n")
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "mixed", workspaces: ["apps/*", "packages/shared"] }),
    )
    await mkdir(join(workspace, "apps/desktop"), { recursive: true })
    await writeFile(join(workspace, "apps/desktop/package.json"), JSON.stringify({ name: "desktop" }))
    await mkdir(join(workspace, "packages/shared"), { recursive: true })
    await writeFile(join(workspace, "packages/shared/package.json"), JSON.stringify({ name: "shared" }))

    expect(await workspaceCachePaths(workspace, undefined)).toEqual([
      "target/debug",
      "target/release",
      "node_modules",
      "apps/desktop/node_modules",
      "packages/shared/node_modules",
    ])
  })

  it("skips Cargo artifact pruning when only non-target caches were seeded", async () => {
    const prune = vi.fn(async () => {})
    await writeFile(join(workspace, ".gitignore"), "node_modules/\ntarget/\n")
    await cache(source, "node_modules", "pkg")
    const seeded = await seedWorkspaceCaches({
      workspace,
      sources: [source],
      paths: ["node_modules"],
      clone: copy,
      prune,
    })
    expect(seeded).toEqual([{ path: "node_modules", source }])
    expect(prune).not.toHaveBeenCalled()
  })
})
