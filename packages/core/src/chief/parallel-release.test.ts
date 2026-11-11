import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { taskEvidenceRefs } from "./parallel-evidence"
import { parallelGit } from "./parallel-git"
import {
  collectTaskDelivery,
  disposeTaskWorktree,
  integrateTaskWorktree,
  prepareTaskWorktree,
  releaseAppliedTaskWorktrees,
} from "./parallel-workspace"
import type { Mission } from "./types"

let directory: string
let mission: Mission
const git = (args: string[]) => parallelGit(mission.workspace.path, args)
const missing = (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-parallel-release-"))
  const root = join(directory, "mission")
  await mkdir(root)
  mission = {
    id: "release-fixture",
    goal: "Release Actor storage",
    chiefId: "chief",
    personas: [],
    workspace: {
      issueId: "release-fixture",
      key: "fixture",
      path: root,
      branch: "fixture",
      status: "idle",
      createdAt: "2026-11-11",
    },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "completed",
    tasks: [],
    history: [],
    createdAt: "2026-11-11",
    updatedAt: "2026-11-11",
  }
  await git(["init", "-q", "-b", "fixture"])
  await writeFile(join(root, "a.txt"), "A baseline\n")
  await writeFile(join(root, ".gitignore"), "target/\n.agent-valley/\n")
  await git(["add", "."])
  await git([
    "-c",
    "user.name=AV release test",
    "-c",
    "user.email=release@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ])
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("completed mission Actor storage release", () => {
  it("removes applied Actor repositories, including attempts superseded by a later repair", async () => {
    const rejected = await prepareTaskWorktree(mission, "task", 1)
    await writeFile(join(rejected.path, "a.txt"), "Rejected attempt\n")
    await mkdir(join(rejected.path, "target"), { recursive: true })
    await writeFile(join(rejected.path, "target", "build.bin"), "build output")
    await integrateTaskWorktree(mission, rejected)
    const repaired = await prepareTaskWorktree(mission, "task", 2)
    await writeFile(join(repaired.path, "a.txt"), "Repaired attempt\n")
    await integrateTaskWorktree(mission, repaired)
    // The superseded attempt no longer matches the mission tree, so per-task disposal keeps it forever.
    expect(await disposeTaskWorktree(rejected)).toBe(false)

    const result = await releaseAppliedTaskWorktrees(mission)

    expect(result.released.sort()).toEqual([rejected.path, repaired.path].sort())
    expect(result.retained).toEqual([])
    await missing(rejected.path)
    await missing(repaired.path)
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Repaired attempt\n")
    for (const workspace of [rejected, repaired]) {
      const refs = taskEvidenceRefs(workspace)
      expect((await git(["rev-parse", "--verify", refs.workerRef])).trim()).toMatch(/^[a-f0-9]{40,64}$/)
      const key = workspace.path.split("/").at(-1) ?? ""
      const receipt = join(dirname(dirname(workspace.path)), "deliveries", key)
      expect(await readFile(join(receipt, "changes.patch"), "utf8")).toContain("a.txt")
    }
  })

  it("keeps unapplied and unrecorded Actor repositories because their edits may exist nowhere else", async () => {
    const prepared = await prepareTaskWorktree(mission, "pending", 1)
    await writeFile(join(prepared.path, "a.txt"), "Collected but never integrated\n")
    await collectTaskDelivery(mission, prepared)
    const running = await prepareTaskWorktree(mission, "running", 1)
    await writeFile(join(running.path, "a.txt"), "Actor still working\n")
    const stray = join(dirname(prepared.path), "unrecorded")
    await mkdir(stray)
    await writeFile(join(stray, "notes.txt"), "Unknown edits\n")

    const result = await releaseAppliedTaskWorktrees(mission)

    expect(result.released).toEqual([])
    expect(result.retained.sort()).toEqual([prepared.path, running.path, stray].sort())
    expect(await readFile(join(prepared.path, "a.txt"), "utf8")).toBe("Collected but never integrated\n")
    expect(await readFile(join(running.path, "a.txt"), "utf8")).toBe("Actor still working\n")
    expect(await readFile(join(stray, "notes.txt"), "utf8")).toBe("Unknown edits\n")
  })

  it("returns empty results when the mission never ran parallel Actors", async () => {
    expect(await releaseAppliedTaskWorktrees(mission)).toEqual({ released: [], retained: [] })
  })

  it("dry run lists applied Actor repositories without removing them, and honors referenced paths", async () => {
    const applied = await prepareTaskWorktree(mission, "applied", 1)
    await writeFile(join(applied.path, "a.txt"), "Applied\n")
    await integrateTaskWorktree(mission, applied)
    expect(await releaseAppliedTaskWorktrees(mission, { apply: false })).toEqual({
      released: [applied.path],
      retained: [],
    })
    expect(await readFile(join(applied.path, "a.txt"), "utf8")).toBe("Applied\n")
    expect(await releaseAppliedTaskWorktrees(mission, { keep: new Set([applied.path]) })).toEqual({
      released: [],
      retained: [applied.path],
    })
  })

  it("refuses a new Actor clone when the volume is below the free-disk minimum, after reclaiming applied clones", async () => {
    const applied = await prepareTaskWorktree(mission, "reclaimable", 1)
    await writeFile(join(applied.path, "a.txt"), "Applied\n")
    await integrateTaskWorktree(mission, applied)
    vi.stubEnv("AV_MIN_FREE_DISK_GIB", String(1024 ** 3))
    await expect(prepareTaskWorktree(mission, "next", 1)).rejects.toThrow("av gc --apply")
    await missing(applied.path)
  })
})
