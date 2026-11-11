import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { archiveContinuousChild, readContinuousChildArchive } from "./continuous-archive"
import type { ContinuousBaseline } from "./continuous-contract"
import { mission, operation, timestamp } from "./continuous-operation.fixture"
import { ContinuousOperationStore } from "./continuous-store"
import { createContinuousMissionWorkspace, prepareContinuousBaseline } from "./continuous-workspace"
import { fingerprintWorkspace } from "./fingerprint"
import { parallelGit } from "./parallel-git"
import { collectStorageGarbage } from "./storage-gc"
import { MissionStore } from "./store"
import type { Mission } from "./types"

let directory: string
let root: string
let records: MissionStore
const children = new Map<string, Mission>()
const days = (count: number) => () => new Date(Date.parse(timestamp) + count * 86_400_000)
const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-storage-gc-")))
  root = join(directory, "repository")
  await mkdir(root)
  await parallelGit(root, ["init", "-q", "-b", "main"])
  await writeFile(join(root, ".gitignore"), ".agent-valley/\nignored.txt\ntarget/\n")
  await writeFile(join(root, "product.txt"), "initial\n")
  await parallelGit(root, ["add", "."])
  await parallelGit(root, [
    "-c",
    "user.name=AV test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "initial",
  ])
  // Operator-owned ignored files in the real checkout must never be touched.
  await mkdir(join(root, "target"))
  await writeFile(join(root, "target", "operator.bin"), "operator build")
  records = new MissionStore(join(root, ".agent-valley", "missions"))
  const baselines: ContinuousBaseline[] = [await prepareContinuousBaseline(root, "operation", root)]
  children.clear()
  for (const id of ["one", "two", "three"]) {
    const prior = baselines.at(-1) as ContinuousBaseline
    const workspace = await createContinuousMissionWorkspace(root, "operation", prior.path, id, "Improve")
    await writeFile(join(workspace.path, "product.txt"), `${id} uncommitted product\n`)
    await mkdir(join(workspace.path, "target"))
    await writeFile(join(workspace.path, "target", "build.bin"), `${id} build output`)
    await mkdir(join(workspace.path, ".agent-valley", "parallel", "deliveries"), { recursive: true })
    await writeFile(join(workspace.path, ".agent-valley", "parallel", "deliveries", "receipt.json"), `"${id}"`)
    const fingerprint = await fingerprintWorkspace(workspace.path)
    const child = mission(id, "Improve")
    child.repositoryRoot = root
    child.workspace = workspace
    child.fingerprint = fingerprint
    child.verification = { ok: true, fingerprint }
    await records.save(child)
    children.set(id, child)
    baselines.push(await prepareContinuousBaseline(root, "operation", workspace.path, id, fingerprint))
  }
  await new ContinuousOperationStore(join(root, ".agent-valley", "operations")).save(
    operation({
      repositoryRoot: root,
      baseline: baselines.at(-1),
      phase: "completed",
      completedCycles: 3,
      history: baselines.slice(1).map((entry) => ({
        missionId: entry.missionId as string,
        goal: "Improve",
        reason: "Verified",
        evidence: [],
        completedAt: timestamp,
        baselinePath: entry.path,
      })),
    }),
  )
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const workspace = (id: string) => children.get(id)?.workspace.path as string
const container = (id: string) => join(root, ".agent-valley", "operations", "operation", "workspaces", id)

describe("storage garbage collection", () => {
  it("reports eligible storage without removing anything by default", async () => {
    const { applied, entries } = await collectStorageGarbage(root, { now: days(8) })
    expect(applied).toBe(false)
    expect(entries.filter((entry) => entry.kind === "build-output").map((entry) => entry.missionId)).toEqual([
      "one",
      "three",
      "two",
    ])
    // Only "one" is outside the operation's two most recent accepted children.
    expect(entries.filter((entry) => entry.kind === "child-archive")).toMatchObject([
      { missionId: "one", outcome: "eligible" },
    ])
    for (const id of ["one", "two", "three"])
      expect(await present(join(workspace(id), "target", "build.bin"))).toBe(true)
    expect(await present(workspace("one"))).toBe(true)
  })

  it("releases build output, archives an idle child losslessly, and never touches the operator checkout", async () => {
    await collectStorageGarbage(root, { apply: true, now: days(8) })

    expect(await readFile(join(root, "target", "operator.bin"), "utf8")).toBe("operator build")
    for (const id of ["two", "three"]) {
      expect(await present(join(workspace(id), "target"))).toBe(false)
      expect(await readFile(join(workspace(id), "product.txt"), "utf8")).toBe(`${id} uncommitted product\n`)
      expect(await present(join(workspace(id), ".agent-valley", "parallel", "deliveries", "receipt.json"))).toBe(true)
    }

    expect(await present(workspace("one"))).toBe(false)
    const archive = await readContinuousChildArchive(container("one"))
    if (!archive) throw new Error("Expected an archive receipt for child one")
    expect(await parallelGit(archive.repository, ["show", `${archive.productCommit}:product.txt`])).toBe(
      "one uncommitted product\n",
    )
    expect(
      await readFile(
        join(container("one"), "archive", "agent-valley", "parallel", "deliveries", "receipt.json"),
        "utf8",
      ),
    ).toBe('"one"')
    expect(await present(join(container("one"), "workspace.json"))).toBe(true)
  })

  it("keeps finished children whole until they have been idle for the retention period", async () => {
    const { entries } = await collectStorageGarbage(root, { apply: true, now: days(1) })
    expect(entries.some((entry) => entry.kind === "child-archive")).toBe(false)
    expect(await present(workspace("one"))).toBe(true)
  })

  it("never touches a mission with a lock or active process marker", async () => {
    await writeFile(join(root, ".agent-valley", "missions", "one.json.lock"), "{}")
    const { entries } = await collectStorageGarbage(root, { apply: true, now: days(8) })
    expect(entries.some((entry) => entry.missionId === "one")).toBe(false)
    expect(await present(join(workspace("one"), "target", "build.bin"))).toBe(true)
  })

  it("keeps recent failed missions but releases them after the retention period", async () => {
    const child = children.get("three") as Mission
    child.status = "failed"
    await records.save(child)
    const recent = await collectStorageGarbage(root, { apply: true, now: days(1) })
    expect(recent.entries.some((entry) => entry.missionId === "three")).toBe(false)
    const stale = await collectStorageGarbage(root, { apply: true, now: days(8) })
    expect(stale.entries).toContainEqual(
      expect.objectContaining({ kind: "build-output", missionId: "three", outcome: "released" }),
    )
  })

  it("rejects an invalid retention period with the fix in the message", async () => {
    await expect(collectStorageGarbage(root, { staleDays: -1 })).rejects.toThrow("non-negative number of days")
  })

  it("finishes an interrupted archive idempotently and refuses containers without an AV receipt", async () => {
    expect((await archiveContinuousChild(container("one"))).status).toBe("archived")
    await mkdir(workspace("one"))
    await writeFile(join(workspace("one"), "leftover.txt"), "partial delete")
    expect((await archiveContinuousChild(container("one"))).status).toBe("already-archived")
    expect(await present(workspace("one"))).toBe(false)
    const foreign = join(directory, "foreign")
    await mkdir(foreign)
    await expect(archiveContinuousChild(foreign)).rejects.toThrow("no matching AV operation child receipt")
  })
})
