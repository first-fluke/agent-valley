import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runJoinedWave } from "./parallel"
import { retainTaskEvidence, taskEvidenceRefs } from "./parallel-evidence"
import { parallelGit } from "./parallel-git"
import {
  captureParallelBaseline,
  collectTaskDelivery,
  disposeTaskWorktree,
  integrateTaskDelivery,
  integrateTaskWorktree,
  ParallelIntegrationConflict,
  prepareTaskWorktree,
} from "./parallel-workspace"
import type { Mission } from "./types"

let directory: string
let mission: Mission
const git = (args: string[]) => parallelGit(mission.workspace.path, args)

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-parallel-test-"))
  const root = join(directory, "mission")
  await mkdir(root)
  mission = {
    id: "parallel-fixture",
    goal: "Parallel product work",
    chiefId: "chief",
    personas: [],
    workspace: {
      issueId: "parallel-fixture",
      key: "fixture",
      path: root,
      branch: "fixture",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    tasks: [],
    history: [],
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
  }
  await git(["init", "-q", "-b", "fixture"])
  await writeFile(join(root, "a.txt"), "A baseline\n")
  await writeFile(join(root, "b.txt"), "B baseline\n")
  await writeFile(join(root, "remove.txt"), "Delete me\n")
  await writeFile(join(root, "script.sh"), "#!/bin/sh\necho fixture\n")
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]))
  await mkdir(join(root, ".agents"))
  await writeFile(join(root, ".agents", "managed.txt"), "Harness baseline\n")
  await git(["add", "."])
  await git([
    "-c",
    "user.name=AV parallel test",
    "-c",
    "user.email=parallel@example.test",
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

describe("isolated parallel Actor worktrees", () => {
  it("retains the Actor's real snapshot and committed HEAD for independent Git provenance checks", async () => {
    const root = mission.workspace.path
    await mkdir(join(root, "docs"))
    const contract = "The inspected instance-lock contract is real source material.\n"
    await writeFile(join(root, "docs", "contract.md"), contract)
    await writeFile(join(root, "b.txt"), "Unrelated staged operator change\n")
    await git(["add", "b.txt"])
    const head = await git(["rev-parse", "HEAD"])
    const index = await readFile(join(root, ".git", "index"))
    const workspace = await prepareTaskWorktree(mission, "provenance", 1)
    const snapshot = (await parallelGit(workspace.path, ["rev-parse", "HEAD"])).trim()
    expect(snapshot).not.toBe(head.trim())
    expect(workspace.snapshotCommit).toBe(snapshot)
    expect(await git(["show", `${snapshot}:docs/contract.md`])).toBe(contract)
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("A baseline\n")
    await writeFile(join(workspace.path, "a.txt"), "Verified Actor implementation\n")
    await writeFile(join(workspace.path, "proof.md"), `Inspected original snapshot ${snapshot}.\n`)
    await parallelGit(workspace.path, ["add", "a.txt", "proof.md"])
    await parallelGit(workspace.path, [
      "-c", "user.name=AV Actor", "-c", "user.email=actor@example.test",
      "-c", "commit.gpgsign=false", "commit", "-qm", "Actor implementation",
    ])
    const worker = (await parallelGit(workspace.path, ["rev-parse", "HEAD"])).trim()
    const delivery = await collectTaskDelivery(mission, workspace)
    expect(delivery.workerHead).toBe(worker)
    expect(await git(["show", `${worker}:a.txt`])).toBe("Verified Actor implementation\n")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("A baseline\n")
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    await integrateTaskDelivery(mission, delivery)
    const review = await prepareTaskWorktree(mission, "independent-review", 1)
    expect((await parallelGit(review.path, ["rev-parse", "HEAD"])).trim()).not.toBe(snapshot)
    expect(await parallelGit(review.path, ["show", `${snapshot}:docs/contract.md`])).toBe(contract)
    expect(await parallelGit(review.path, ["show", `${worker}:proof.md`])).toContain(snapshot)
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("Unrelated staged operator change\n")
  })

  it("restores original evidence refs before an already applied receipt returns, even after Actor disposal", async () => {
    const workspace = await prepareTaskWorktree(mission, "restore-evidence", 1)
    await writeFile(join(workspace.path, "a.txt"), "Delivered product\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await integrateTaskDelivery(mission, delivery)
    expect(await disposeTaskWorktree(workspace)).toBe(true)
    const refs = taskEvidenceRefs(workspace)
    await git(["update-ref", "-d", refs.snapshotRef])
    await git(["update-ref", "-d", refs.workerRef])
    const head = await git(["rev-parse", "HEAD"])
    const index = await readFile(join(mission.workspace.path, ".git", "index"))
    expect((await integrateTaskDelivery(mission, delivery)).alreadyApplied).toBe(true)
    expect((await git(["rev-parse", refs.snapshotRef])).trim()).toBe(workspace.snapshotCommit)
    expect((await git(["rev-parse", refs.workerRef])).trim()).toBe(delivery.workerHead)
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Delivered product\n")
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(mission.workspace.path, ".git", "index"))).toEqual(index)
  })

  it("rejects caller-controlled refs and a snapshot with a mismatched original tree", async () => {
    const workspace = await prepareTaskWorktree(mission, "forged-evidence", 1)
    const snapshot = workspace.snapshotCommit as string
    const head = await git(["rev-parse", "HEAD"])
    const index = await readFile(join(mission.workspace.path, ".git", "index"))
    await expect(
      retainTaskEvidence({ ...workspace, workerRef: "refs/heads/fixture" }, "worker", snapshot),
    ).rejects.toThrow("owned task path and private references")
    await expect(
      retainTaskEvidence({ ...workspace, baselineTree: "f".repeat(40) }, "snapshot", snapshot),
    ).rejects.toThrow("recorded parent and product tree")
    await expect(retainTaskEvidence(workspace, "worker", "f".repeat(40))).rejects.toThrow()
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(mission.workspace.path, ".git", "index"))).toEqual(index)
  })

  it("keeps an already disposed legacy applied receipt idempotent without inventing revision evidence", async () => {
    const workspace = await prepareTaskWorktree(mission, "disposed-legacy-evidence", 1)
    await writeFile(join(workspace.path, "a.txt"), "Already completed legacy product\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await integrateTaskDelivery(mission, delivery)
    expect(await disposeTaskWorktree(workspace)).toBe(true)
    const refs = taskEvidenceRefs(workspace)
    await git(["update-ref", "-d", refs.snapshotRef])
    await git(["update-ref", "-d", refs.workerRef])
    delete delivery.workerHead
    delete delivery.workspace.snapshotCommit
    delete delivery.workspace.snapshotRef
    delete delivery.workspace.workerRef
    const receipt = join(dirname(delivery.patchPath), "delivery.json")
    await writeFile(receipt, JSON.stringify(delivery))
    const saved = await readFile(receipt, "utf8")
    const head = await git(["rev-parse", "HEAD"])
    const index = await readFile(join(mission.workspace.path, ".git", "index"))
    expect((await integrateTaskDelivery(mission, delivery)).alreadyApplied).toBe(true)
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(JSON.parse(saved))
    expect(delivery.workerHead).toBeUndefined()
    expect(await git(["for-each-ref", "--format=%(objectname)", `refs/agent-valley/task-evidence/${refs.key}`])).toBe("")
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Already completed legacy product\n")
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(mission.workspace.path, ".git", "index"))).toEqual(index)
  })

  it.each([false, true])("recovers legacy receipt provenance only with an unchanged delivered tree: changed=%s", async (changed) => {
    const workspace = await prepareTaskWorktree(mission, "legacy-evidence", 1)
    await writeFile(join(workspace.path, "a.txt"), "Legacy delivered product\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await integrateTaskDelivery(mission, delivery)
    delete delivery.workerHead
    delete delivery.workspace.snapshotCommit
    delete delivery.workspace.snapshotRef
    delete delivery.workspace.workerRef
    const receipt = join(dirname(delivery.patchPath), "delivery.json")
    await writeFile(join(dirname(delivery.patchPath), "workspace.json"), JSON.stringify(delivery.workspace))
    await writeFile(receipt, JSON.stringify(delivery))
    await git(["update-ref", "-d", taskEvidenceRefs(workspace).workerRef])
    if (changed) await writeFile(join(workspace.path, "a.txt"), "Unproven later Actor change\n")
    if (changed) {
      await expect(integrateTaskDelivery(mission, delivery)).rejects.toThrow("Legacy parallel evidence")
      expect(await git(["for-each-ref", "--format=%(objectname)", taskEvidenceRefs(workspace).workerRef])).toBe("")
    } else {
      expect((await integrateTaskDelivery(mission, delivery)).alreadyApplied).toBe(true)
      const actual = (await parallelGit(workspace.path, ["rev-parse", "HEAD"])).trim()
      expect((await git(["rev-parse", taskEvidenceRefs(workspace).workerRef])).trim()).toBe(actual)
    }
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Legacy delivered product\n")
  })

  it("ignores inherited Git repository/index routing and only uses the Actor's private repository", async () => {
    const root = mission.workspace.path
    const originalHead = await git(["rev-parse", "HEAD"])
    const originalIndex = await readFile(join(root, ".git", "index"))
    vi.stubEnv("GIT_DIR", join(root, ".git"))
    vi.stubEnv("GIT_WORK_TREE", root)
    vi.stubEnv("GIT_INDEX_FILE", join(root, ".git", "index"))
    vi.stubEnv("GIT_COMMON_DIR", join(root, ".git"))
    const workspace = await prepareTaskWorktree(mission, "inherited-env", 1)
    await writeFile(join(workspace.path, "a.txt"), "Isolated Actor output\n")
    await integrateTaskWorktree(mission, workspace)
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("Isolated Actor output\n")
    expect(await readFile(join(root, ".git", "index"))).toEqual(originalIndex)
    expect(await git(["rev-parse", "HEAD"])).toBe(originalHead)
    expect(await parallelGit(workspace.path, ["branch", "--show-current"])).toBe(`${workspace.branch}\n`)
  })

  it("copies the current staged, unstaged, untracked, deleted snapshot without altering the mission index or HEAD", async () => {
    const root = mission.workspace.path
    await writeFile(join(root, "a.txt"), "A staged operator change\n")
    await git(["add", "a.txt"])
    await writeFile(join(root, "a.txt"), "A unstaged operator continuation\n")
    await writeFile(join(root, "untracked.txt"), "Original untracked deliverable\n")
    await rm(join(root, "remove.txt"))
    const head = await git(["rev-parse", "HEAD"])
    const index = await git(["diff", "--cached", "--binary"])
    const workspace = await prepareTaskWorktree(mission, "first", 1)
    expect(await readFile(join(workspace.path, "a.txt"), "utf8")).toBe("A unstaged operator continuation\n")
    expect(await readFile(join(workspace.path, "untracked.txt"), "utf8")).toBe("Original untracked deliverable\n")
    await expect(lstat(join(workspace.path, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await lstat(join(workspace.path, ".git"))).isDirectory()).toBe(true)
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await git(["diff", "--cached", "--binary"])).toBe(index)
    await writeFile(join(workspace.path, "child.txt"), "Preserved across prepare retry\n")
    expect(await prepareTaskWorktree(mission, "first", 1)).toEqual(workspace)
    expect(await readFile(join(workspace.path, "child.txt"), "utf8")).toContain("Preserved")
  })

  it("snapshots literal glob-like names, explicitly staged ignored products and staged deletions without broad ignored inclusion", async () => {
    const root = mission.workspace.path
    await writeFile(join(root, ".gitignore"), ".agents/\n.agent-valley/\nignored-*.txt\n")
    await git(["add", ".gitignore"])
    await writeFile(join(root, "ignored-product.txt"), "Explicitly staged product\n")
    await git(["add", "-f", "ignored-product.txt"])
    await writeFile(join(root, "ignored-untracked.txt"), "Must remain excluded\n")
    await rm(join(root, "remove.txt"))
    await git(["add", "-u", "--", "remove.txt"])
    const names = ["literal[1]*?.txt", ":(glob)unusual*.txt", "literal1ordinary.txt"]
    for (const name of names) await writeFile(join(root, name), `Literal filename ${name}\n`)
    const head = await git(["rev-parse", "HEAD"])
    const index = await readFile(join(root, ".git", "index"))
    vi.stubEnv("GIT_LITERAL_PATHSPECS", "1")
    vi.stubEnv("GIT_GLOB_PATHSPECS", "1")
    vi.stubEnv("GIT_NOGLOB_PATHSPECS", "1")
    vi.stubEnv("GIT_ICASE_PATHSPECS", "1")
    const workspace = await prepareTaskWorktree(mission, "literal-snapshot", 1)
    for (const name of names)
      expect(await readFile(join(workspace.path, name), "utf8")).toBe(`Literal filename ${name}\n`)
    expect(await readFile(join(workspace.path, "ignored-product.txt"), "utf8")).toBe("Explicitly staged product\n")
    await expect(lstat(join(workspace.path, "ignored-untracked.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(workspace.path, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
  })

  it("overlaps isolated children, then integrates disjoint results in deterministic order", async () => {
    const snapshot = await captureParallelBaseline(mission.workspace.path)
    const workspaces = await Promise.all([
      prepareTaskWorktree(mission, "a", 1, snapshot),
      prepareTaskWorktree(mission, "b", 1, snapshot),
    ])
    let release: () => void = () => {}
    let started: () => void = () => {}
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    const both = new Promise<void>((resolve) => {
      started = resolve
    })
    let count = 0
    const running = runJoinedWave(workspaces, async (workspace) => {
      await writeFile(join(workspace.path, `${workspace.taskId}.txt`), `${workspace.taskId} output\n`)
      if (++count === 2) started()
      await finish
      return workspace
    })
    await both
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("A baseline\n")
    release()
    const results = await running
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    for (const workspace of workspaces) await integrateTaskWorktree(mission, workspace)
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("a output\n")
    expect(await readFile(join(mission.workspace.path, "b.txt"), "utf8")).toBe("b output\n")
  }, 30_000)

  it("delivers binary edits, executable modes, deletions, symlinks and unusual untracked names while retaining operator changes", async () => {
    const root = mission.workspace.path
    await writeFile(join(root, "a.txt"), "Operator baseline retained\n")
    await git(["add", "a.txt"])
    const originalIndex = await git(["diff", "--cached", "--binary"])
    const workspace = await prepareTaskWorktree(mission, "delivery", 1)
    await writeFile(join(workspace.path, "binary.bin"), Buffer.from([0, 9, 8, 255, 0]))
    await chmod(join(workspace.path, "script.sh"), 0o755)
    await rm(join(workspace.path, "remove.txt"))
    await symlink("a.txt", join(workspace.path, "link"))
    const name = "space and\nnewline.txt"
    await writeFile(join(workspace.path, name), "New real deliverable\n")
    const receipt = await integrateTaskWorktree(mission, workspace)
    expect(receipt.changedPaths).toEqual(["binary.bin", "link", "remove.txt", "script.sh", name].sort())
    expect(await readFile(join(root, "binary.bin"))).toEqual(Buffer.from([0, 9, 8, 255, 0]))
    expect((await lstat(join(root, "script.sh"))).mode & 0o111).toBe(0o111)
    expect(await readlink(join(root, "link"))).toBe("a.txt")
    expect(await readFile(join(root, name), "utf8")).toBe("New real deliverable\n")
    await expect(lstat(join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("Operator baseline retained\n")
    expect(await git(["diff", "--cached", "--binary"])).toBe(originalIndex)
  })

  it("rejects identical same-file work from a second Actor and retains both the first result and conflicting edits", async () => {
    const snapshot = await captureParallelBaseline(mission.workspace.path)
    const [first, second] = await Promise.all([
      prepareTaskWorktree(mission, "first", 1, snapshot),
      prepareTaskWorktree(mission, "second", 1, snapshot),
    ])
    await Promise.all(
      [first, second].map((workspace) => writeFile(join(workspace.path, "a.txt"), "Same proposed edit\n")),
    )
    await integrateTaskWorktree(mission, first)
    await expect(integrateTaskWorktree(mission, second)).rejects.toBeInstanceOf(ParallelIntegrationConflict)
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Same proposed edit\n")
    expect(await readFile(join(second.path, "a.txt"), "utf8")).toBe("Same proposed edit\n")
    expect(await disposeTaskWorktree(second)).toBe(false)
  })

  it("accepts unrelated shared edits and rejects changed base images instead of overwriting them", async () => {
    const workspace = await prepareTaskWorktree(mission, "change", 1)
    await writeFile(join(workspace.path, "a.txt"), "Actor change\n")
    await writeFile(join(mission.workspace.path, "b.txt"), "Concurrent unrelated edit\n")
    await integrateTaskWorktree(mission, workspace)
    expect(await readFile(join(mission.workspace.path, "b.txt"), "utf8")).toBe("Concurrent unrelated edit\n")
    const conflict = await prepareTaskWorktree(mission, "conflict", 1)
    await writeFile(join(conflict.path, "a.txt"), "Next Actor edit\n")
    await writeFile(join(mission.workspace.path, "a.txt"), "Operator current edit\n")
    await expect(integrateTaskWorktree(mission, conflict)).rejects.toThrow("edits were retained")
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Operator current edit\n")
  })

  it("excludes managed harness and receipt files from task patches", async () => {
    const workspace = await prepareTaskWorktree(mission, "harness", 1)
    await writeFile(join(workspace.path, ".agents", "managed.txt"), "Actor must not deliver this\n")
    await mkdir(join(workspace.path, ".agents", "results"))
    await writeFile(join(workspace.path, ".agents", "results", "receipt.json"), "{}")
    await mkdir(join(workspace.path, ".agent-valley", "receipts"), { recursive: true })
    await writeFile(join(workspace.path, ".agent-valley", "receipts", "run.json"), "{}")
    await writeFile(join(workspace.path, "a.txt"), "Actual product\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    expect(delivery.changes.map((change) => change.path)).toEqual(["a.txt"])
    await integrateTaskDelivery(mission, delivery)
    expect(await readFile(join(mission.workspace.path, ".agents", "managed.txt"), "utf8")).toBe("Harness baseline\n")
    await expect(lstat(join(mission.workspace.path, ".agents", "results", "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("durable patch integration", () => {
  it("recognizes an apply that finished before its checkpoint and never applies it twice, even after disposal", async () => {
    const workspace = await prepareTaskWorktree(mission, "resume", 1)
    await writeFile(join(workspace.path, "a.txt"), "Resume output\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await writeFile(
      join(dirname(delivery.patchPath), "delivery.json"),
      JSON.stringify({ ...delivery, status: "applying" }),
    )
    await git(["apply", "--binary", delivery.patchPath])
    expect(await integrateTaskDelivery(mission, delivery)).toMatchObject({ alreadyApplied: true })
    expect(await integrateTaskDelivery(mission, delivery)).toMatchObject({ alreadyApplied: true })
    expect(await disposeTaskWorktree(workspace)).toBe(true)
    expect(await integrateTaskWorktree(mission, workspace)).toMatchObject({ alreadyApplied: true })
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Resume output\n")
  })

  it("reports interrupted partial delivery without repeating or discarding either file", async () => {
    const workspace = await prepareTaskWorktree(mission, "partial", 1)
    await writeFile(join(workspace.path, "a.txt"), "Actor A\n")
    await writeFile(join(workspace.path, "b.txt"), "Actor B\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await writeFile(
      join(dirname(delivery.patchPath), "delivery.json"),
      JSON.stringify({ ...delivery, status: "applying" }),
    )
    await writeFile(join(mission.workspace.path, "a.txt"), "Actor A\n")
    await expect(integrateTaskDelivery(mission, delivery)).rejects.toThrow("Integration was interrupted")
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("Actor A\n")
    expect(await readFile(join(mission.workspace.path, "b.txt"), "utf8")).toBe("B baseline\n")
    expect(await readFile(join(workspace.path, "b.txt"), "utf8")).toBe("Actor B\n")
  })

  it("preserves edits made after patch collection and only removes an unchanged applied workspace", async () => {
    const workspace = await prepareTaskWorktree(mission, "retain", 1)
    expect(await disposeTaskWorktree(workspace)).toBe(false)
    await writeFile(join(workspace.path, "a.txt"), "Frozen patch\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await writeFile(join(workspace.path, "extra.txt"), "Keep these later edits\n")
    await integrateTaskDelivery(mission, delivery)
    expect(await disposeTaskWorktree(workspace)).toBe(false)
    expect(await readFile(join(workspace.path, "extra.txt"), "utf8")).toBe("Keep these later edits\n")
  })

  it("rejects changed patches and foreign task records before touching the mission", async () => {
    const workspace = await prepareTaskWorktree(mission, "identity", 1)
    await writeFile(join(workspace.path, "a.txt"), "Patch\n")
    const delivery = await collectTaskDelivery(mission, workspace)
    await expect(collectTaskDelivery(mission, { ...workspace, missionId: "other" })).rejects.toThrow(
      "different mission",
    )
    await writeFile(delivery.patchPath, "Changed patch")
    await expect(integrateTaskDelivery(mission, delivery)).rejects.toThrow("patch changed")
    expect(await readFile(join(mission.workspace.path, "a.txt"), "utf8")).toBe("A baseline\n")
  })

  it("can integrate and clean an empty product delivery", async () => {
    const workspace = await prepareTaskWorktree(mission, "empty", 1)
    expect(await integrateTaskWorktree(mission, workspace)).toEqual({ alreadyApplied: false, changedPaths: [] })
    expect(await disposeTaskWorktree(workspace)).toBe(true)
  })
})
