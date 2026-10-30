import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { operation as operationFixture } from "@agent-valley/core/chief/continuous-operation.fixture"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { operationStore, type runOperation } from "../chief-continuous"
import type { superviseOrder } from "../chief-supervisor"
import { watchOrders } from "../chief-watch"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-operation-watch-")))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("durable operation watching", () => {
  it("resumes the saved operation without independently launching its child", async () => {
    const child = missionFixture()
    child.status = "executing"
    const missions = new MissionStore(join(root, ".agent-valley", "missions"))
    await missions.save(child)
    const saved = operationFixture({
      repositoryRoot: root,
      phase: "running",
      currentMissionId: child.id,
      decision: { action: "execute", goal: child.goal, reason: "Original evidence", evidence: ["Original source"] },
    })
    await operationStore(root).save(saved)
    const controller = new AbortController()
    const mission = vi.fn<typeof superviseOrder>()
    const operation = vi.fn<typeof runOperation>().mockImplementation(async (goal, options, cwd, dependencies) => {
      expect(goal).toBeUndefined()
      expect(options).toEqual({ resume: saved.id })
      expect(cwd).toBe(root)
      expect(dependencies?.signal?.aborted).toBe(false)
      expect(await operationStore(root).load(saved.id)).toEqual(saved)
      controller.abort()
      return saved
    })
    await watchOrders(root, {
      signal: controller.signal,
      mission,
      operation,
      delay: vi.fn().mockResolvedValue(undefined),
    })
    expect(operation).toHaveBeenCalledOnce()
    expect(mission).not.toHaveBeenCalled()
    expect(await missions.load(child.id)).toEqual(child)
  })

  it.each([undefined, "interrupted", "blocked"] as const)(
    "retains %s pauses when no child recovery is authorized",
    async (pauseKind) => {
      const child = missionFixture()
      child.status = "paused"
      await new MissionStore(join(root, ".agent-valley", "missions")).save(child)
      const saved = operationFixture({
        repositoryRoot: root,
        phase: "paused",
        pauseKind,
        currentMissionId: child.id,
        decision: { action: "execute", goal: child.goal, reason: "Saved decision", evidence: ["Saved source"] },
      })
      await operationStore(root).save(saved)
      const controller = new AbortController()
      const operation = vi.fn<typeof runOperation>()
      await watchOrders(root, {
        signal: controller.signal,
        operation,
        delay: async () => {
          controller.abort()
        },
      })
      expect(operation).not.toHaveBeenCalled()
      expect(await operationStore(root).load(saved.id)).toEqual(saved)
    },
  )

  it.each(["retry", "cancelled", "expired"] as const)(
    "checks the saved child's %s authorization before resuming a blocked operation",
    async (kind) => {
      const child = missionFixture()
      child.status = "paused"
      child.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 60 })
      child.execution = {
        startedAt: new Date(Date.now() - (kind === "expired" ? 120_000 : 0)).toISOString(),
        runsStarted: 4,
        retries: 1,
      }
      if (!child.supervision) throw new Error("Expected saved Chief recovery")
      child.supervision.pendingRecovery = { reason: "Retry the original provider request" }
      await new MissionStore(join(root, ".agent-valley", "missions")).save(child)
      const saved = operationFixture({
        repositoryRoot: root,
        phase: "paused",
        pauseKind: kind === "cancelled" ? "interrupted" : "blocked",
        currentMissionId: child.id,
        decision: { action: "execute", goal: child.goal, reason: "Original decision", evidence: ["Original source"] },
      })
      await operationStore(root).save(saved)
      const controller = new AbortController()
      const operation = vi.fn<typeof runOperation>().mockResolvedValue(saved)
      await watchOrders(root, {
        signal: controller.signal,
        operation,
        delay: async () => {
          controller.abort()
        },
      })
      expect(operation).toHaveBeenCalledTimes(kind === "retry" ? 1 : 0)
      expect(await new MissionStore(join(root, ".agent-valley", "missions")).load(child.id)).toEqual(child)
    },
  )
})
