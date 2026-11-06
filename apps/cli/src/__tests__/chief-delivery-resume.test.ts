import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { prepareSourceIntegration } from "@agent-valley/core/chief/continuous-source-integration"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runOrder } from "../chief"
import { deliverMissionCode } from "../chief-code-delivery"
import { operationStore, runOperation } from "../chief-continuous"
import { enableMissionDelivery, enableOperationDelivery } from "../chief-delivery-resume"
import { applyResumeOptions, validateResumeOptions } from "../chief-resume"
import { deliveryFixture, git } from "./chief-code-delivery.fixture"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const options = { deliver: "main", deliveryPaths: '["allowed.ts","new.ts"]' }

async function legacy() {
  const value = await deliveryFixture()
  directories.push(value.temporary)
  delete value.mission.codeDelivery
  await value.store.save(value.mission)
  return value
}

function operation(value: Awaited<ReturnType<typeof legacy>>): ContinuousOperation {
  return {
    id: randomUUID(),
    repositoryRoot: value.source,
    charter: "Continue the original staged implementation",
    settings: { workspace: value.source, actor: "codex", model: "operator-model", runs: "20", duration: "300" },
    phase: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedCycles: 0,
    waitIntervalSec: 300,
    currentMissionId: value.mission.id,
    decisionId: randomUUID(),
    decision: {
      action: "execute",
      goal: value.mission.goal,
      reason: "Implement the original goal",
      evidence: ["Original accepted baseline"],
    },
    history: [],
    sourceIntegrationPolicy: { mode: "worktree", branch: "main", head: "a".repeat(40) },
    sourceIntegration: {
      phase: "unchanged",
      missionId: value.mission.id,
      branch: "main",
      sourceHead: "a".repeat(40),
      previousTree: "b".repeat(40),
      nextTree: "b".repeat(40),
      paths: [],
      at: new Date().toISOString(),
    },
  }
}

describe("enable remote code delivery on resume", () => {
  it("pins a previously absent policy without changing the original goal, acceptance, workspace or spent limits", async () => {
    const value = await legacy()
    const before = structuredClone(value.mission)
    validateResumeOptions(undefined, { resume: value.mission.id, ...options })
    applyResumeOptions(value.mission, undefined, { resume: value.mission.id, ...options })
    expect(await enableMissionDelivery(value.mission, options, value.store)).toBe(true)
    const saved = await value.store.load(value.mission.id)
    expect(saved.codeDelivery).toMatchObject({
      phase: "pending",
      attempts: 0,
      policy: {
        branch: "main",
        paths: ["allowed.ts", "new.ts"],
        baseSha: await git(value.source, "rev-parse", "HEAD"),
      },
    })
    expect(saved.execution).toEqual(before.execution)
    expect(saved.executionPolicy).toEqual(before.executionPolicy)
    expect(saved.goal).toBe(before.goal)
    expect(saved.plan).toEqual(before.plan)
    expect(saved.workspace).toEqual(before.workspace)
    expect(saved.verification).toEqual(before.verification)
    expect(saved.history.at(-1)?.stage).toBe("code-delivery-enabled")
    expect(await readFile(`${value.source}/allowed.ts`, "utf8")).toContain("value = 1")
  })

  it("delivers an already verified legacy Mission without restarting its implementation", async () => {
    const value = await legacy()
    const before = structuredClone(value.mission.execution)
    await enableMissionDelivery(value.mission, options, value.store)
    await deliverMissionCode(value.mission, value.store)
    expect(value.mission.codeDelivery?.phase).toBe("pushed")
    expect(await readFile(`${value.source}/allowed.ts`, "utf8")).toContain("value = 2")
    expect(await git(value.remote, "rev-parse", "main")).toBe(value.mission.codeDelivery?.commitSha)
    expect(value.mission.execution).toEqual(before)
  })

  it("accepts delivery activation through the actual single-Mission resume command", async () => {
    const value = await legacy()
    const before = structuredClone(value.mission.execution)
    const result = await runOrder(undefined, { resume: value.mission.id, worker: true, ...options }, value.source)
    expect(result.codeDelivery?.phase).toBe("pushed")
    expect(result.execution).toEqual(before)
    expect(await git(value.remote, "rev-parse", "main")).toBe(result.codeDelivery?.commitSha)
  })

  it("treats repeated identical activation as a no-op while preserving the original delivery receipt", async () => {
    const value = await legacy()
    await enableMissionDelivery(
      value.mission,
      { ...options, deliveryMessage: "fix: original approved message" },
      value.store,
    )
    const before = structuredClone(value.mission)
    expect(
      await enableMissionDelivery(value.mission, { ...options, deliveryPaths: '["new.ts","allowed.ts"]' }, value.store),
    ).toBe(false)
    expect(value.mission).toEqual(before)
  })

  it.each(["pending", "prepared", "committed", "pushed", "blocked", "unchanged"] as const)(
    "never replaces an existing %s delivery policy",
    async (phase) => {
      const value = await legacy()
      await enableMissionDelivery(value.mission, options, value.store)
      const delivery = value.mission.codeDelivery
      if (!delivery) throw new Error("Expected enabled delivery")
      delivery.phase = phase
      const before = structuredClone(delivery)
      await expect(
        enableMissionDelivery(value.mission, { ...options, deliveryMessage: "fix: replacement" }, value.store),
      ).rejects.toThrow("cannot be replaced")
      expect(value.mission.codeDelivery).toEqual(before)
    },
  )

  it.each(["execution", "effect"])("refuses activation while a saved %s outcome is uncertain", async (kind) => {
    const value = await legacy()
    if (kind === "execution")
      value.mission.operations = {
        runs: [
          {
            runId: "uncertain",
            stage: "work",
            actorId: "worker",
            actorType: "codex",
            startedAt: new Date().toISOString(),
            finishedAt: null,
            elapsedMs: null,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            outcome: "failed",
            executionState: "unknown",
          },
        ],
        routingEvidence: [],
        reviewDecisions: [],
      }
    else if (value.mission.tasks[0]) value.mission.tasks[0].effectState = "unknown"
    await expect(enableMissionDelivery(value.mission, options, value.store)).rejects.toThrow("running or unknown")
    expect(value.mission.codeDelivery).toBeUndefined()
  })

  it("preserves source WIP instead of converting existing local integration into an implicit commit", async () => {
    const value = await legacy()
    await writeFile(`${value.source}/other.ts`, "Uncommitted source work\n")
    const status = await git(value.source, "status", "--porcelain")
    await expect(enableMissionDelivery(value.mission, options, value.store)).rejects.toThrow("clean source")
    expect(await git(value.source, "status", "--porcelain")).toBe(status)
    expect(value.mission.codeDelivery).toBeUndefined()
  })

  it("requires an explicit branch and exact product paths", async () => {
    const value = await legacy()
    await expect(
      enableMissionDelivery(value.mission, { deliveryPaths: '["allowed.ts"]' }, value.store),
    ).rejects.toThrow("--deliver")
    await expect(enableMissionDelivery(value.mission, { deliver: "main" }, value.store)).rejects.toThrow(
      "--delivery-paths",
    )
    await expect(
      enableMissionDelivery(value.mission, { ...options, deliveryPaths: '[".env"]' }, value.store),
    ).rejects.toThrow()
    expect(value.mission.codeDelivery).toBeUndefined()
  })
})

describe("enable continuous delivery without replacing an order", () => {
  it("validates remote activation before applying a pending local source catch-up", async () => {
    const value = await legacy()
    const parent = operation(value)
    await prepareContinuousBaseline(value.source, parent.id, value.source)
    parent.baseline = await prepareContinuousBaseline(
      value.source,
      parent.id,
      value.workspace,
      value.mission.id,
      value.mission.verification?.fingerprint,
    )
    parent.sourceIntegrationPolicy = await prepareSourceIntegration(value.source, parent.id)
    parent.sourceIntegration = undefined
    parent.currentMissionId = undefined
    parent.phase = "deciding"
    parent.completedCycles = 1
    await operationStore(value.source).save(parent)
    const before = await operationStore(value.source).load(parent.id)
    const index = await readFile(`${value.source}/.git/index`)
    const head = await git(value.source, "rev-parse", "HEAD")
    const status = await git(value.source, "status", "--porcelain")
    const decide = vi.fn(async () => {
      throw new Error("Invalid delivery options must not select another goal")
    })
    const runMission = vi.fn(async () => {
      throw new Error("Invalid delivery options must not launch a child")
    })

    await expect(
      runOperation(undefined, { resume: parent.id, deliver: "main", deliveryPaths: "not-json" }, value.source, {
        decide,
        runMission,
      }),
    ).rejects.toThrow("--delivery-paths")

    expect(await readFile(`${value.source}/allowed.ts`, "utf8")).toBe("export const value = 1\n")
    expect(await readFile(`${value.source}/.git/index`)).toEqual(index)
    expect(await git(value.source, "rev-parse", "HEAD")).toBe(head)
    expect(await git(value.source, "status", "--porcelain")).toBe(status)
    expect(await operationStore(value.source).load(parent.id)).toEqual(before)
    expect((await value.store.load(value.mission.id)).codeDelivery).toBeUndefined()
    expect(decide).not.toHaveBeenCalled()
    expect(runMission).not.toHaveBeenCalled()
  })

  it("activates delivery on the original operation, delivers its completed child and accepts that same cycle", async () => {
    const value = await legacy()
    const parent = operation(value)
    parent.cycleLimit = 1
    await operationStore(value.source).save(parent)
    const spent = structuredClone(value.mission.execution)
    const runMission = vi.fn(async () => runOrder(undefined, { resume: value.mission.id, worker: true }, value.source))
    const decide = vi.fn(async () => {
      throw new Error("The completed cycle must not be replaced with a new goal")
    })
    const result = await runOperation(undefined, { resume: parent.id, ...options }, value.source, {
      runMission,
      decide,
    })
    expect(result.phase).toBe("completed")
    expect(result.completedCycles).toBe(1)
    expect(result.history.at(-1)?.missionId).toBe(value.mission.id)
    expect(result.sourceIntegrationPolicy).toEqual({ mode: "snapshot-only" })
    expect(result.sourceIntegration).toEqual(parent.sourceIntegration)
    expect((await value.store.load(value.mission.id)).codeDelivery?.phase).toBe("pushed")
    expect((await value.store.load(value.mission.id)).execution).toEqual(spent)
    expect(runMission).toHaveBeenCalledOnce()
    expect(decide).not.toHaveBeenCalled()
  })
  it("updates the same active child and future-child settings while retaining every execution and local-integration receipt", async () => {
    const value = await legacy()
    const parent = operation(value)
    const before = structuredClone(parent)
    const spent = structuredClone(value.mission.execution)
    const save = vi.fn(async (_operation: ContinuousOperation) => {})
    const disableLocal = vi.fn((current: ContinuousOperation) => {
      current.sourceIntegrationPolicy = { mode: "snapshot-only" }
    })
    expect(await enableOperationDelivery(parent, options, value.source, save, disableLocal)).toBe(true)
    expect(parent.currentMissionId).toBe(before.currentMissionId)
    expect(parent.decision).toEqual(before.decision)
    expect(parent.charter).toBe(before.charter)
    expect(parent.settings).toMatchObject({
      ...before.settings,
      deliver: "main",
      deliveryPaths: '["allowed.ts","new.ts"]',
    })
    expect(parent.sourceIntegrationPolicy).toEqual({ mode: "snapshot-only" })
    expect(parent.sourceIntegration).toEqual(before.sourceIntegration)
    expect(save).toHaveBeenCalledOnce()
    expect((await value.store.load(value.mission.id)).codeDelivery?.phase).toBe("pending")
    expect((await value.store.load(value.mission.id)).execution).toEqual(spent)
  })

  it("can pin delivery for future cycles without creating or replacing a child", async () => {
    const value = await legacy()
    const parent = operation(value)
    parent.currentMissionId = undefined
    parent.phase = "deciding"
    const before = (await value.store.list()).map((mission) => mission.id)
    await enableOperationDelivery(parent, options, value.source, async () => {})
    expect((await value.store.list()).map((mission) => mission.id)).toEqual(before)
    expect(parent.settings.deliver).toBe("main")
    expect(parent.currentMissionId).toBeUndefined()
  })

  it("does not mutate a live child or partially enable future delivery when its lock is held", async () => {
    const value = await legacy()
    const parent = operation(value)
    const before = structuredClone(parent)
    const unlock = await value.store.lock(value.mission.id)
    try {
      await expect(enableOperationDelivery(parent, options, value.source, async () => {})).rejects.toThrow(
        /active|running|lock/i,
      )
      expect(parent).toEqual(before)
      expect((await value.store.load(value.mission.id)).codeDelivery).toBeUndefined()
    } finally {
      await unlock()
    }
  })

  it("recovers an activation persisted on the child before the parent save failed without replacing receipts", async () => {
    const value = await legacy()
    const parent = operation(value)
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Parent storage temporarily unavailable"))
      .mockResolvedValue(undefined)
    await expect(enableOperationDelivery(parent, options, value.source, save)).rejects.toThrow("Parent storage")
    const first = (await value.store.load(value.mission.id)).codeDelivery
    await enableOperationDelivery(parent, options, value.source, save)
    const child = await value.store.load(value.mission.id)
    expect(child.codeDelivery).toEqual(first)
    expect(child.history.filter((entry) => entry.stage === "code-delivery-enabled")).toHaveLength(1)
    expect(parent.settings.deliver).toBe("main")
  })

  it("rejects a foreign active child's goal before changing parent settings", async () => {
    const value = await legacy()
    const parent = operation(value)
    if (parent.decision?.action === "execute") parent.decision.goal = "A different unauthorized goal"
    const before = structuredClone(parent)
    await expect(enableOperationDelivery(parent, options, value.source, async () => {})).rejects.toThrow(
      "original source and goal",
    )
    expect(parent).toEqual(before)
    expect((await value.store.load(value.mission.id)).codeDelivery).toBeUndefined()
  })
})
