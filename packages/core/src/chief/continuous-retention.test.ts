import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { recordContinuousAcceptance } from "./continuous-acceptance-record"
import type { ContinuousBaseline } from "./continuous-contract"
import { mission, operation, timestamp } from "./continuous-operation.fixture"
import { pruneContinuousBaselines } from "./continuous-retention"
import { ContinuousOperationStore } from "./continuous-store"
import { createContinuousMissionWorkspace, prepareContinuousBaseline } from "./continuous-workspace"
import { fingerprintWorkspace } from "./fingerprint"
import { parallelGit } from "./parallel-git"
import { MissionStore } from "./store"

let directory: string
let root: string
let baselines: ContinuousBaseline[]
let records: MissionStore
let operations: ContinuousOperationStore
const target = () => baselines[1] as ContinuousBaseline

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-retention-")))
  root = join(directory, "repository")
  await mkdir(root)
  await parallelGit(root, ["init", "-q", "-b", "main"])
  await writeFile(join(root, ".gitignore"), ".agent-valley/\nignored.txt\n")
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
  records = new MissionStore(join(root, ".agent-valley", "missions"))
  operations = new ContinuousOperationStore(join(root, ".agent-valley", "operations"))
  baselines = [await prepareContinuousBaseline(root, "operation", root)]
  for (const id of ["one", "two", "three"]) {
    const prior = baselines.at(-1) as ContinuousBaseline
    const workspace = await createContinuousMissionWorkspace(root, "operation", prior.path, id, "Improve")
    await writeFile(join(workspace.path, "product.txt"), `${id}\n`)
    const fingerprint = await fingerprintWorkspace(workspace.path)
    const child = mission(id, "Improve")
    child.repositoryRoot = root
    child.workspace = workspace
    child.fingerprint = fingerprint
    child.verification = { ok: true, fingerprint }
    await records.save(child)
    baselines.push(await prepareContinuousBaseline(root, "operation", workspace.path, id, fingerprint))
  }
  await operations.save(
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

async function outcome(apply = false) {
  return (await pruneContinuousBaselines(root, "operation", { apply })).candidates.find((entry) => entry.key === "one")
}

async function prepareInterruption() {
  const snapshot = target()
  const raw = await readFile(join(dirname(snapshot.path), "baseline.json"), "utf8")
  const stat = await lstat(snapshot.path)
  const quarantine = join(dirname(snapshot.path), "workspace.pruning")
  await writeFile(
    join(dirname(snapshot.path), "pruning.json"),
    JSON.stringify({
      version: 1,
      operationId: "operation",
      missionId: "one",
      path: snapshot.path,
      quarantine,
      commit: snapshot.commit,
      tree: snapshot.baselineTree,
      recoveryCommit: baselines.at(-1)?.commit,
      baselineDigest: createHash("sha256").update(raw).digest("hex"),
      device: stat.dev,
      inode: stat.ino,
      at: timestamp,
    }),
  )
  await rename(snapshot.path, quarantine)
  return quarantine
}

describe("explicit frozen continuous baseline pruning", () => {
  it("defaults to a read-only plan and removes only the obsolete clone after --apply, preserving all mission evidence", async () => {
    expect(await outcome()).toMatchObject({ status: "eligible" })
    expect(await readFile(join(target().path, "product.txt"), "utf8")).toBe("one\n")
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    await expect(lstat(target().path)).rejects.toMatchObject({ code: "ENOENT" })
    for (const snapshot of [baselines[0], baselines[2], baselines[3]])
      expect((await lstat(snapshot?.path as string)).isDirectory()).toBe(true)
    for (const name of ["baseline.json", "snapshot.json", "pruning.json", "pruned.json"])
      expect((await lstat(join(dirname(target().path), name))).isFile()).toBe(true)
    const child = await records.load("one")
    expect(await readFile(join(child.workspace.path, "product.txt"), "utf8")).toBe("one\n")
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    expect((await parallelGit(baselines[3]?.path as string, ["show", `${target().commit}:product.txt`])).trim()).toBe(
      "one",
    )
  })

  it.each(["product.txt", "untracked.txt", "ignored.txt"])(
    "preserves %s edits in an otherwise obsolete baseline",
    async (path) => {
      await writeFile(join(target().path, path), "preserve\n")
      expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("changes") })
      expect(await readFile(join(target().path, path), "utf8")).toBe("preserve\n")
    },
  )

  it("preserves extra Git refs and repository dependencies", async () => {
    await parallelGit(target().path, ["branch", "unrecorded-work"])
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("references") })
    await parallelGit(target().path, ["branch", "-D", "unrecorded-work"])
    await writeFile(join(target().path, ".git", "objects", "info", "alternates"), "/outside/objects\n")
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("depends") })
  })

  it("preserves unrecorded commits that were reset away but remain in the clone reflog", async () => {
    await parallelGit(target().path, [
      "-c",
      "user.name=AV test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "unrecorded user work",
    ])
    await parallelGit(target().path, ["reset", "--hard", target().commit])
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("unrecorded history") })
    expect((await lstat(target().path)).isDirectory()).toBe(true)
  })

  it("preserves any active or uncertain process marker and a live mission lock", async () => {
    const base = join(root, ".agent-valley", "missions")
    const marker = join(base, "one.run-uncertain.active")
    await writeFile(marker, "uncertain")
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("marker") })
    await rm(marker)
    const release = await records.lock("one")
    try {
      expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("lock") })
    } finally {
      await release()
    }
  })

  it("preserves a failed original mission and the baseline needed by an unresolved child", async () => {
    const child = await records.load("one")
    child.status = "failed"
    await records.save(child)
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("completion") })
    const later = await records.load("two")
    later.status = "paused"
    await records.save(later)
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("referenced") })
  })

  it("keeps the last locally applied baseline across later snapshot-only cycles", async () => {
    const value = await operations.load("operation")
    value.sourceIntegration = {
      phase: "applied",
      missionId: "one",
      branch: "main",
      sourceHead: target().baselineHead,
      previousTree: baselines[0]?.baselineTree as string,
      nextTree: target().baselineTree,
      paths: ["product.txt"],
      at: timestamp,
    }
    await operations.save(value)
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("referenced") })
  })

  it("does not follow a substituted workspace symlink", async () => {
    const outside = join(directory, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "keep.txt"), "user data")
    await rm(target().path, { recursive: true })
    await symlink(outside, target().path)
    expect(await outcome(true)).toMatchObject({ status: "kept" })
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("user data")
  })

  it("requires the original snapshot receipt and a recovery commit reachable from the accepted baseline", async () => {
    const path = join(dirname(target().path), "snapshot.json")
    const raw = await readFile(path, "utf8")
    await rm(path)
    expect(await outcome(true)).toMatchObject({ status: "kept" })
    const orphan = (
      await parallelGit(target().path, [
        "-c",
        "user.name=AV test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        target().baselineTree,
        "-m",
        "unreachable",
      ])
    ).trim()
    const changed = { ...target(), commit: orphan }
    await writeFile(path, JSON.stringify(changed))
    await writeFile(join(dirname(target().path), "baseline.json"), JSON.stringify(changed))
    expect(await outcome(true)).toMatchObject({
      status: "kept",
      reason: expect.stringContaining("not proven reachable"),
    })
    expect(raw).toContain("baseline-one")
  })

  it("protects current child and decision input baselines even when they differ from the latest baseline", async () => {
    for (const field of ["currentMissionId", "decisionId"] as const) {
      const id = field === "currentMissionId" ? "active-child" : "active-decision"
      await createContinuousMissionWorkspace(root, "operation", target().path, id, "Improve")
      const receiptPath = join(root, ".agent-valley", "operations", "operation", "workspaces", id, "workspace.json")
      const workspaceReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>
      workspaceReceipt.baselinePath = target().path.replace("/one/workspace", "/one/../one/workspace")
      await writeFile(receiptPath, JSON.stringify(workspaceReceipt))
      const value = await operations.load("operation")
      value[field] = id
      if (field === "currentMissionId") {
        value.phase = "running"
        value.decision = { action: "execute", goal: "Improve", reason: "Measured", evidence: ["source"] }
      }
      await operations.save(value)
      expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("referenced") })
    }
  })

  it("keeps immutable acceptance proof after history passes twenty entries, while legacy missing proof remains protected", async () => {
    const saved = await operations.load("operation")
    const original = saved.history[0]
    if (!original) throw new Error("Expected first acceptance")
    const historic = { ...saved, baseline: target(), completedCycles: 1, history: [original] }
    saved.completedCycles = 25
    saved.history = [
      ...Array.from({ length: 18 }, (_, index) => ({
        missionId: `displaced-${index}`,
        goal: "Prior improvement",
        reason: "Verified",
        evidence: [],
        completedAt: timestamp,
        baselinePath: join(
          root,
          ".agent-valley",
          "operations",
          "operation",
          "baselines",
          `displaced-${index}`,
          "workspace",
        ),
      })),
      ...saved.history.slice(-2),
    ]
    await operations.save(saved)
    expect(await outcome()).toMatchObject({
      status: "kept",
      reason: expect.stringContaining("No retained accepted-cycle"),
    })
    await recordContinuousAcceptance(historic)
    const path = join(dirname(target().path), "acceptance.json")
    const receipt = await readFile(path, "utf8")
    await recordContinuousAcceptance(historic)
    expect(await readFile(path, "utf8")).toBe(receipt)
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    expect(await readFile(path, "utf8")).toBe(receipt)
  })

  it("never rewrites conflicting acceptance evidence or records an unfinished snapshot", async () => {
    const saved = await operations.load("operation")
    const original = saved.history[0]
    if (!original) throw new Error("Expected first acceptance")
    const historic = { ...saved, baseline: target(), completedCycles: 1, history: [original] }
    const path = join(dirname(target().path), "acceptance.json")
    await recordContinuousAcceptance({ ...historic, completedCycles: 0, history: [] })
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
    await recordContinuousAcceptance(historic)
    const receipt = await readFile(path, "utf8")
    await expect(recordContinuousAcceptance({ ...historic, completedCycles: 2 })).rejects.toThrow("differs")
    expect(await readFile(path, "utf8")).toBe(receipt)
  })

  it("refuses pruning while the operation itself has a live owner", async () => {
    const unlock = await operations.lock("operation")
    try {
      await expect(pruneContinuousBaselines(root, "operation", { apply: true })).rejects.toThrow("already running")
      expect((await lstat(target().path)).isDirectory()).toBe(true)
    } finally {
      await unlock()
    }
  })

  it("preserves nested ignored evidence and symlinked Git metadata", async () => {
    const evidence = join(target().path, ".agent-valley", "parallel", "retained.txt")
    await writeFile(evidence, "failed Actor evidence")
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("changes") })
    await rm(evidence)
    const outside = join(directory, "outside-object-store")
    await mkdir(outside)
    await rename(join(target().path, ".git", "objects"), join(outside, "objects"))
    await symlink(join(outside, "objects"), join(target().path, ".git", "objects"))
    expect(await outcome(true)).toMatchObject({ status: "kept", reason: expect.stringContaining("symbolic link") })
    expect((await lstat(join(outside, "objects"))).isDirectory()).toBe(true)
  })

  it("resumes an intact recorded quarantine without overwriting its prepared receipt", async () => {
    await prepareInterruption()
    const path = join(dirname(target().path), "pruning.json")
    const before = await readFile(path, "utf8")
    expect(await outcome()).toMatchObject({ status: "eligible" })
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    expect(await readFile(path, "utf8")).toBe(before)
  })

  it("preserves partially deleted or changed quarantines after an interruption", async () => {
    const quarantine = await prepareInterruption()
    await rm(join(quarantine, ".git"), { recursive: true })
    expect(await outcome(true)).toMatchObject({ status: "kept" })
    expect(await readFile(join(quarantine, "product.txt"), "utf8")).toBe("one\n")
    expect((await lstat(join(dirname(target().path), "pruning.json"))).isFile()).toBe(true)
  })

  it("finishes a lost completion receipt idempotently after the recorded clone was removed", async () => {
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    await rm(join(dirname(target().path), "pruned.json"))
    expect(await outcome(true)).toMatchObject({ status: "pruned" })
    expect((await lstat(join(dirname(target().path), "pruned.json"))).isFile()).toBe(true)
  })
})
