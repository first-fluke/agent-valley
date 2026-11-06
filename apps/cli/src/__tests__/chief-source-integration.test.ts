import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContinuousBaseline, ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import {
  mission as missionFixture,
  operation as operationFixture,
} from "@agent-valley/core/chief/continuous-operation.fixture"
import { integrateContinuousSource } from "@agent-valley/core/chief/continuous-source-integration"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import {
  createContinuousMissionWorkspace,
  prepareContinuousBaseline,
} from "@agent-valley/core/chief/continuous-workspace"
import { fingerprintWorkspace } from "@agent-valley/core/chief/fingerprint"
import { parallelGit } from "@agent-valley/core/chief/parallel-git"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initialSourceIntegration, resumeSourceIntegration } from "../chief-source-integration"

let directory: string
let root: string
let storage: ContinuousOperationStore
const git = (args: string[]) => parallelGit(root, args)
const receiptPath = (missionId = "child-one") =>
  join(root, ".agent-valley", "operations", "operation", "source-integrations", missionId, "integration.json")

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-source-resume-")))
  root = join(directory, "repository")
  await mkdir(root)
  await git(["init", "-q", "-b", "main"])
  await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
  await writeFile(join(root, "product.txt"), "Initial product\n")
  await writeFile(join(root, "other.txt"), "Other product\n")
  await git(["add", "."])
  await git([
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
  storage = new ContinuousOperationStore(join(root, ".agent-valley", "operations"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function cycle(previous: ContinuousBaseline, contents: string, id = "child-one") {
  const child = await createContinuousMissionWorkspace(root, "operation", previous.path, id, "Improve")
  await writeFile(join(child.path, "product.txt"), contents)
  return prepareContinuousBaseline(root, "operation", child.path, id, await fingerprintWorkspace(child.path))
}

async function fixture() {
  const initial = await prepareContinuousBaseline(root, "operation", root)
  const accepted = await cycle(initial, "First verified cycle\n")
  const operation = operationFixture({
    repositoryRoot: root,
    baseline: accepted,
    completedCycles: 1,
    decisionId: "saved-decision",
    settings: { actor: "grok", model: "pinned-chief", workspace: root, runs: "19", repairs: "2", rounds: "8" },
    recovery: {
      target: "decision",
      checkpointId: "saved-decision",
      attempts: 3,
      failedAttempts: 2,
      disposition: "retrying",
      reason: "Continue the same selection",
    },
  })
  await storage.save(operation)
  return { operation, initial, accepted }
}

describe("continuous source integration policy and resume", () => {
  it("defaults new local operations to worktree and explicit remote delivery to snapshot-only", async () => {
    expect(await initialSourceIntegration(root, "operation", undefined)).toMatchObject({
      mode: "worktree",
      branch: "main",
    })
    expect(await initialSourceIntegration(root, "operation", undefined, "main")).toEqual({ mode: "snapshot-only" })
    expect(await initialSourceIntegration(root, "operation", "snapshot-only")).toEqual({ mode: "snapshot-only" })
    await expect(initialSourceIntegration(root, "operation", "worktree", "main")).rejects.toThrow("either")
    await expect(initialSourceIntegration(root, "operation", "invalid")).rejects.toThrow("worktree or snapshot-only")
  })

  it("leaves legacy snapshot operations unchanged on ordinary resume", async () => {
    const { operation } = await fixture()
    const before = structuredClone(operation)
    const save = vi.fn(async () => {})

    await resumeSourceIntegration(operation, undefined, root, undefined, save)

    expect(operation).toEqual(before)
    expect(save).not.toHaveBeenCalled()
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("saves the activation pin before source writes and preserves the existing decision and spent limits", async () => {
    const { operation } = await fixture()
    const settings = structuredClone(operation.settings)
    const recovery = structuredClone(operation.recovery)
    const states: ContinuousOperation[] = []
    const sourceAtSave: string[] = []
    const save = async (current: ContinuousOperation) => {
      states.push(structuredClone(current))
      sourceAtSave.push(await readFile(join(root, "product.txt"), "utf8"))
      await storage.save(current)
    }

    await resumeSourceIntegration(operation, "worktree", root, undefined, save)

    expect(states[0]?.sourceIntegrationPolicy).toMatchObject({ mode: "worktree", branch: "main" })
    expect(states[0]?.sourceIntegration).toBeUndefined()
    expect(sourceAtSave[0]).toBe("Initial product\n")
    expect(operation).toMatchObject({ phase: "deciding", decisionId: "saved-decision", completedCycles: 1 })
    expect(operation.settings).toEqual(settings)
    expect(operation.recovery).toEqual(recovery)
    expect(operation.sourceIntegration?.missionId).toBe("child-one")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("First verified cycle\n")
  })

  it("finishes catch-up on ordinary resume after interruption following the durable activation save", async () => {
    const { operation } = await fixture()
    await expect(
      resumeSourceIntegration(operation, "worktree", root, undefined, async (current) => {
        await storage.save(current)
        throw new Error("interrupted after pin save")
      }),
    ).rejects.toThrow("after pin save")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
    const restored = await storage.load(operation.id)
    const policy = structuredClone(restored.sourceIntegrationPolicy)

    await resumeSourceIntegration(restored, undefined, root)

    expect(restored.sourceIntegrationPolicy).toEqual(policy)
    expect(restored.sourceIntegration?.missionId).toBe("child-one")
    expect(restored.completedCycles).toBe(1)
    expect(restored.decisionId).toBe("saved-decision")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("First verified cycle\n")
  })

  it("retains enabled policy and pauses the same checkpoint on conflict, then resumes without re-pinning", async () => {
    const { operation } = await fixture()
    await writeFile(join(root, "product.txt"), "Concurrent source edit\n")

    await expect(resumeSourceIntegration(operation, "worktree", root)).rejects.toThrow("overlap")

    const saved = await storage.load(operation.id)
    const policy = structuredClone(saved.sourceIntegrationPolicy)
    expect(saved).toMatchObject({
      phase: "paused",
      resumePhase: "deciding",
      pauseKind: "blocked",
      decisionId: "saved-decision",
      completedCycles: 1,
    })
    expect(policy).toMatchObject({ mode: "worktree" })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Concurrent source edit\n")
    await writeFile(join(root, "product.txt"), "Initial product\n")

    await resumeSourceIntegration(saved, undefined, root)

    expect(saved.sourceIntegrationPolicy).toEqual(policy)
    expect(saved.recovery).toEqual(operation.recovery)
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("First verified cycle\n")
  })

  it("reconciles an applied private receipt when the operation summary was not saved before process exit", async () => {
    const { operation, initial, accepted } = await fixture()
    operation.sourceIntegrationPolicy = await initialSourceIntegration(root, operation.id)
    await storage.save(operation)
    await integrateContinuousSource(operation, initial, accepted)
    const restored = await storage.load(operation.id)
    expect(restored.sourceIntegration).toBeUndefined()

    await expect(resumeSourceIntegration(restored, "snapshot-only", root)).rejects.toThrow("awaiting child acceptance")
    expect(restored.sourceIntegrationPolicy?.mode).toBe("worktree")

    await resumeSourceIntegration(restored, undefined, root)

    expect((await storage.load(operation.id)).sourceIntegration?.missionId).toBe("child-one")
    expect(restored.completedCycles).toBe(1)
    expect(restored.decisionId).toBe("saved-decision")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("First verified cycle\n")
  })

  it("catches up from the last applied snapshot after disable, snapshot-only cycles and re-enable", async () => {
    const { operation, accepted } = await fixture()
    await resumeSourceIntegration(operation, "worktree", root)
    await resumeSourceIntegration(operation, "snapshot-only", root)
    expect(operation.sourceIntegration?.missionId).toBe("child-one")
    const next = await cycle(accepted, "Second verified cycle\n", "child-two")
    operation.baseline = next
    operation.completedCycles = 2
    await storage.save(operation)

    await resumeSourceIntegration(operation, "worktree", root)

    expect(operation.sourceIntegration).toMatchObject({
      missionId: "child-two",
      previousTree: accepted.baselineTree,
      nextTree: next.baselineTree,
    })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Second verified cycle\n")
    expect(operation.completedCycles).toBe(2)
    expect(operation.decisionId).toBe("saved-decision")
  })

  it("never re-pins source HEAD on ordinary resume", async () => {
    const { operation } = await fixture()
    await resumeSourceIntegration(operation, "worktree", root)
    const policy = structuredClone(operation.sourceIntegrationPolicy)
    await git([
      "-c",
      "user.name=AV test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "other commit",
    ])

    await expect(resumeSourceIntegration(operation, undefined, root)).rejects.toThrow("HEAD moved")

    expect(operation.sourceIntegrationPolicy).toEqual(policy)
    expect(operation.phase).toBe("paused")
    const source = await readFile(join(root, "product.txt"), "utf8")
    await resumeSourceIntegration(operation, "snapshot-only", root)
    expect(operation.sourceIntegrationPolicy).toEqual({ mode: "snapshot-only" })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe(source)
  })

  it("explicitly re-pins worktree mode after a settled accepted result was committed by the operator", async () => {
    const { operation } = await fixture()
    await resumeSourceIntegration(operation, "worktree", root)
    const original = structuredClone(operation.sourceIntegrationPolicy)
    const settings = structuredClone(operation.settings)
    const recovery = structuredClone(operation.recovery)
    await git(["add", "product.txt"])
    await git([
      "-c",
      "user.name=AV test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "operator accepted source",
    ])
    const head = (await git(["rev-parse", "HEAD"])).trim()

    await resumeSourceIntegration(operation, "worktree", root)

    expect(operation.sourceIntegrationPolicy).toEqual({ mode: "worktree", branch: "main", head })
    expect(operation.sourceIntegrationPolicy).not.toEqual(original)
    expect(operation.sourceIntegration?.missionId).toBe("child-one")
    expect(operation.completedCycles).toBe(1)
    expect(operation.decisionId).toBe("saved-decision")
    expect(operation.settings).toEqual(settings)
    expect(operation.recovery).toEqual(recovery)
  })

  it("switches a prepared but unapplied catch-up to snapshot-only without touching source files", async () => {
    const { operation } = await fixture()
    operation.sourceIntegrationPolicy = await initialSourceIntegration(root, operation.id)
    await storage.save(operation)
    await writeFile(join(root, "product.txt"), "Concurrent operator edit\n")
    await expect(resumeSourceIntegration(operation, undefined, root)).rejects.toThrow("overlap")
    expect(JSON.parse(await readFile(receiptPath(), "utf8")).status).toBe("prepared")

    await resumeSourceIntegration(operation, "snapshot-only", root)

    expect(operation.sourceIntegrationPolicy).toEqual({ mode: "snapshot-only" })
    expect(operation.sourceIntegration).toBeUndefined()
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Concurrent operator edit\n")
    expect(JSON.parse(await readFile(receiptPath(), "utf8")).status).toBe("prepared")
  })

  it("does not discard a partial transaction when snapshot-only is selected", async () => {
    const { operation } = await fixture()
    await resumeSourceIntegration(operation, "worktree", root)
    const receipt = JSON.parse(await readFile(receiptPath(), "utf8"))
    receipt.status = "applying"
    await writeFile(receiptPath(), JSON.stringify(receipt))
    operation.sourceIntegration = undefined
    const policy = structuredClone(operation.sourceIntegrationPolicy)

    await expect(resumeSourceIntegration(operation, "snapshot-only", root)).rejects.toThrow("partially applied")

    expect((await storage.load(operation.id)).sourceIntegrationPolicy).toEqual(policy)
    expect(operation.phase).toBe("paused")
    await resumeSourceIntegration(operation, undefined, root)
    await resumeSourceIntegration(operation, "snapshot-only", root)
    expect(operation.sourceIntegrationPolicy).toEqual({ mode: "snapshot-only" })
  })

  it("rejects activation while the current child has a live owner or unknown external effect", async () => {
    const { operation } = await fixture()
    operation.phase = "running"
    operation.currentMissionId = "active-child"
    const missions = new MissionStore(join(root, ".agent-valley", "missions"))
    const child = missionFixture("active-child", "Continue existing task", "paused")
    await missions.save(child)
    const unlock = await missions.lock(child.id)
    try {
      await expect(resumeSourceIntegration(operation, "worktree", root)).rejects.toThrow("owned by another")
    } finally {
      await unlock()
    }
    if (!child.tasks[0]) throw new Error("Missing task")
    child.tasks[0].effectState = "unknown"
    await missions.save(child)

    await expect(resumeSourceIntegration(operation, "worktree", root)).rejects.toThrow("external-effect outcome")

    expect(operation.sourceIntegrationPolicy).toBeUndefined()
    expect(operation.currentMissionId).toBe(child.id)
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("does not disable source integration when a private receipt is missing beside retained artifacts", async () => {
    const { operation } = await fixture()
    await resumeSourceIntegration(operation, "worktree", root)
    const policy = structuredClone(operation.sourceIntegrationPolicy)
    await rm(receiptPath())

    await expect(resumeSourceIntegration(operation, "snapshot-only", root)).rejects.toThrow("receipt is missing")

    expect((await storage.load(operation.id)).sourceIntegrationPolicy).toEqual(policy)
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("First verified cycle\n")
  })

  it("retains unrelated source index bytes and work through activation catch-up", async () => {
    const { operation } = await fixture()
    await writeFile(join(root, "other.txt"), "Staged operator edit\n")
    await git(["add", "other.txt"])
    await writeFile(join(root, "other.txt"), "Unstaged operator continuation\n")
    await writeFile(join(root, "notes.txt"), "Untracked operator notes\n")
    const index = await readFile(join(root, ".git", "index"))
    const head = await git(["rev-parse", "HEAD"])

    await resumeSourceIntegration(operation, "worktree", root)

    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await git(["rev-parse", "HEAD"])).toBe(head)
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("Unstaged operator continuation\n")
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("Untracked operator notes\n")
  })

  it("rejects worktree activation for saved explicit remote delivery", async () => {
    const { operation } = await fixture()
    operation.settings.deliver = "main"

    await expect(resumeSourceIntegration(operation, "worktree", root)).rejects.toThrow("explicit commit and push")

    expect(operation.sourceIntegrationPolicy).toBeUndefined()
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })
})
