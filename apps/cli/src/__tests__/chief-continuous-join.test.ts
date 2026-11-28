import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { baseline, mission as childFixture, operation } from "@agent-valley/core/chief/continuous-operation.fixture"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { operationStore, runOperation } from "../chief-continuous"

vi.mock("@agent-valley/core/chief/continuous-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent-valley/core/chief/continuous-workspace")>()),
  prepareContinuousBaseline: vi.fn(),
}))

let root: string
let missions: MissionStore
let releaseOwner: (() => Promise<void>) | undefined

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-operation-join-")))
  missions = new MissionStore(join(root, ".agent-valley", "missions"))
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(prepareContinuousBaseline).mockImplementation(async (_repository, id, _source, childId) => {
    const directory = join(root, ".agent-valley", "operations", id, "baselines", childId ?? "initial")
    await mkdir(directory, { recursive: true })
    return {
      ...baseline(childId),
      repositoryRoot: root,
      sourceWorkspacePath: join(root, "child"),
      path: join(directory, "workspace"),
    }
  })
})

afterEach(async () => {
  await releaseOwner?.()
  releaseOwner = undefined
  vi.restoreAllMocks()
  vi.mocked(prepareContinuousBaseline).mockReset()
  await rm(root, { recursive: true, force: true })
})

async function seed() {
  const child = childFixture("child", "Repair login", "paused")
  child.repositoryRoot = root
  child.workspace.path = join(root, "child")
  child.executionPolicy = executionPolicySchema.parse({ maxRuns: 20 })
  child.execution = {
    startedAt: new Date().toISOString(),
    runsStarted: 4,
    retries: 1,
    failureKind: "unknown-effect",
  }
  child.operations = {
    runs: [
      {
        runId: "uncertain-local",
        stage: "work",
        actorId: "worker",
        actorType: "codex",
        startedAt: child.execution.startedAt,
        finishedAt: null,
        elapsedMs: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        outcome: "pending",
        executionState: "unknown",
        executionRecovery: "local-process",
      },
    ],
    routingEvidence: [],
    reviewDecisions: [],
  }
  const parent = operation({
    repositoryRoot: root,
    settings: { workspace: root, actor: "codex", model: "pinned-model" },
    phase: "paused",
    pauseKind: "blocked",
    resumePhase: "running",
    baseline: {
      ...baseline(),
      repositoryRoot: root,
      path: join(root, ".agent-valley", "operations", "operation", "baselines", "initial", "workspace"),
    },
    currentMissionId: child.id,
    decision: { action: "execute", goal: child.goal, reason: "Observed failure", evidence: ["Login evidence"] },
    cycleLimit: 1,
    recovery: { target: "child", checkpointId: child.id, attempts: 2, disposition: "protected", reason: "Unknown run" },
  })
  await missions.save(child)
  await operationStore(root).save(parent)
  releaseOwner = await missions.lock(child.id)
  return { parent, child }
}

async function completeChild(child: Mission) {
  const completed = structuredClone(child)
  completed.status = "completed"
  delete completed.execution?.failureKind
  const run = completed.operations?.runs[0]
  if (!run) throw new Error("Missing fixture run")
  run.executionState = "settled"
  run.finishedAt = new Date().toISOString()
  run.outcome = "passed"
  await missions.save(completed)
  await releaseOwner?.()
  releaseOwner = undefined
  return completed
}

describe("continuous operation joins a live child", () => {
  it("waits before inspecting stale paused/unknown evidence and accepts the completed child exactly once", async () => {
    const { parent, child } = await seed()
    const runMission = vi.fn()
    const decide = vi.fn()
    let polls = 0
    const result = await runOperation(undefined, { resume: parent.id }, root, {
      runMission,
      decide,
      delay: async (milliseconds, signal) => {
        expect(milliseconds).toBeLessThanOrEqual(5_000)
        expect(signal?.aborted).toBe(false)
        expect(await missions.load(child.id)).toEqual(child)
        expect(await operationStore(root).load(parent.id)).toMatchObject({
          phase: "running",
          completedCycles: 0,
          currentMissionId: child.id,
          recovery: { attempts: 2 },
        })
        if (++polls === 2) await completeChild(child)
      },
    })

    expect(polls).toBe(2)
    expect(result).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(result.currentMissionId).toBeUndefined()
    expect(result.history.map((entry) => entry.missionId)).toEqual([child.id])
    expect(runMission).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(prepareContinuousBaseline).toHaveBeenCalledOnce()
    expect(
      JSON.parse(
        await readFile(
          join(root, ".agent-valley", "operations", parent.id, "baselines", child.id, "acceptance.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      operationId: parent.id,
      missionId: child.id,
      cycle: 1,
      baselinePath: result.baseline?.path,
    })
    expect((await missions.load(child.id)).execution).toMatchObject({
      startedAt: child.execution?.startedAt,
      runsStarted: 4,
      retries: 1,
    })
    expect(await readFile(join(root, ".agent-valley", "operation-reports", `${parent.id}.md`), "utf8")).toContain(
      "Verified completed improvements: 1 / 1",
    )

    await runOperation(undefined, { resume: parent.id }, root, { runMission, decide })
    expect(prepareContinuousBaseline).toHaveBeenCalledOnce()
    expect((await operationStore(root).load(parent.id)).completedCycles).toBe(1)
    expect(runMission).not.toHaveBeenCalled()
  })

  it("accepts a finished child when the operator resumes with --retry", async () => {
    const { parent, child } = await seed()
    await completeChild(child)
    const runMission = vi.fn()
    const decide = vi.fn()

    const result = await runOperation(undefined, { resume: parent.id, retry: true }, root, { runMission, decide })

    expect(result).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(result.currentMissionId).toBeUndefined()
    expect(result.history.map((entry) => entry.missionId)).toEqual([child.id])
    expect(runMission).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it("retries a child the operator interrupted when the operation resumes with --retry", async () => {
    const { parent, child } = await seed()
    const interrupted = structuredClone(child)
    if (!interrupted.execution || !interrupted.operations?.runs[0]) throw new Error("Missing fixture execution")
    interrupted.execution.failureKind = "interrupted"
    interrupted.operations.runs[0].executionState = "settled"
    await missions.save(interrupted)
    await releaseOwner?.()
    releaseOwner = undefined
    const retryMission = vi.fn(async () => {
      await completeChild(interrupted)
    })
    const runMission = vi.fn()
    const decide = vi.fn()

    const result = await runOperation(undefined, { resume: parent.id, retry: true }, root, {
      retryMission,
      runMission,
      decide,
    })

    expect(retryMission).toHaveBeenCalledExactlyOnceWith(child.id, expect.any(AbortSignal))
    expect(result).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(runMission).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it("still refuses --retry on the operation while its child is unresolved", async () => {
    const { parent, child } = await seed()

    await expect(runOperation(undefined, { resume: parent.id, retry: true }, root, {})).rejects.toThrow(
      "Resume the current child directly with av order --resume",
    )
    expect(await missions.load(child.id)).toEqual(child)
  })

  it("retries the legacy provider-exhaustion checkpoint without discarding evidence or spend", async () => {
    const { parent, child } = await seed()
    const reason = "Usage allowance exhausted and no other installed, authenticated provider is ready"
    const legacy = structuredClone(child)
    if (!legacy.execution || !legacy.operations?.runs[0] || !legacy.tasks[0])
      throw new Error("Missing fixture child execution")
    legacy.status = "paused"
    legacy.error = reason
    legacy.execution = {
      ...legacy.execution,
      runsStarted: 2,
      retries: 1,
      failureKind: "budget",
      pauseReason: reason,
    }
    legacy.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxEstimatedCostUsd: 5 })
    legacy.supervision = {
      maxRounds: 3,
      rounds: 1,
      stalledRounds: 0,
      decisions: [],
      originalAcceptance: ["Verified improvement"],
      pendingRecovery: { reason, taskId: "work" },
    }
    legacy.handoff = { exhaustedAgents: ["claude"], routes: {}, continuations: {} }
    legacy.tasks[0].output = "Completed implementation before provider recovery"
    legacy.tasks[0].changeSet = {
      version: 1,
      inputTree: "a".repeat(40),
      deliveryTree: "b".repeat(40),
      files: [{ path: "service.txt", status: "modified", size: 12, sha256: "c".repeat(64) }],
      diff: "retained patch evidence",
      diffTruncated: false,
    }
    Object.assign(legacy.operations.runs[0], {
      finishedAt: new Date().toISOString(),
      elapsedMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.25,
      outcome: "failed",
      executionState: "settled",
      evidence: "Provider usage allowance was exhausted.",
    })
    parent.exhaustedProviders = [{ agentType: "claude", at: new Date().toISOString() }]
    parent.recovery = {
      target: "child",
      checkpointId: child.id,
      attempts: 0,
      disposition: "protected",
      reason,
    }
    await missions.save(legacy)
    await operationStore(root).save(parent)
    await releaseOwner?.()
    releaseOwner = undefined

    const retryMission = vi.fn(async (id: string) => {
      const resumed = await missions.load(id)
      expect(resumed.tasks[0]).toMatchObject({
        output: "Completed implementation before provider recovery",
        changeSet: { diff: "retained patch evidence" },
        review: { summary: "Actual product inspected" },
      })
      expect(resumed.execution).toMatchObject({ runsStarted: 2, retries: 1 })
      expect(resumed.executionPolicy).toMatchObject({ maxRuns: 20, maxEstimatedCostUsd: 5 })
      expect(resumed.operations?.runs[0]).toMatchObject({
        runId: "uncertain-local",
        costUsd: 0.25,
        evidence: "Provider usage allowance was exhausted.",
      })
      delete resumed.handoff
      delete resumed.error
      if (resumed.execution) {
        delete resumed.execution.failureKind
        delete resumed.execution.pauseReason
      }
      resumed.status = "completed"
      await missions.save(resumed)
    })
    const result = await runOperation(undefined, { resume: parent.id, retry: true }, root, {
      retryMission,
      runMission: vi.fn(),
      decide: vi.fn(),
    })

    expect(retryMission).toHaveBeenCalledExactlyOnceWith(child.id, expect.any(AbortSignal))
    expect(result).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(result.exhaustedProviders).toBeUndefined()
    expect(result.recovery).toBeUndefined()
    const saved = await missions.load(child.id)
    expect(saved.tasks[0]).toMatchObject({
      output: "Completed implementation before provider recovery",
      changeSet: { diff: "retained patch evidence" },
    })
    expect(saved.execution).toMatchObject({ runsStarted: 2, retries: 1 })
    expect(saved.operations?.runs[0]).toMatchObject({
      runId: "uncertain-local",
      costUsd: 0.25,
      evidence: "Provider usage allowance was exhausted.",
    })
  })

  it("keeps a genuine budget-exhausted child protected from operation-level retry", async () => {
    const { parent, child } = await seed()
    const budget = structuredClone(child)
    if (!budget.execution) throw new Error("Missing fixture child execution")
    budget.execution.failureKind = "budget"
    budget.execution.runsStarted = 20
    budget.execution.pauseReason = "Mission Actor call limit reached."
    budget.error = budget.execution.pauseReason
    await missions.save(budget)
    await releaseOwner?.()
    releaseOwner = undefined
    const retryMission = vi.fn()

    await expect(runOperation(undefined, { resume: parent.id, retry: true }, root, { retryMission })).rejects.toThrow(
      "Resume the current child directly with av order --resume",
    )
    expect(retryMission).not.toHaveBeenCalled()
    expect(await missions.load(child.id)).toMatchObject({
      status: "paused",
      execution: { failureKind: "budget", runsStarted: 20 },
      executionPolicy: { maxRuns: 20 },
    })
  })

  it("cancels only the joining parent and leaves the live owner's child byte-for-byte unchanged", async () => {
    const { parent, child } = await seed()
    const childPath = join(root, ".agent-valley", "missions", `${child.id}.json`)
    const original = await readFile(childPath, "utf8")
    const controller = new AbortController()
    const runMission = vi.fn()
    const decide = vi.fn()
    const result: ContinuousOperation = await runOperation(undefined, { resume: parent.id }, root, {
      signal: controller.signal,
      runMission,
      decide,
      delay: async () => {
        controller.abort()
      },
    })

    expect(result).toMatchObject({ phase: "paused", pauseKind: "interrupted", currentMissionId: child.id })
    expect(result.completedCycles).toBe(0)
    expect(await missions.isLocked(child.id)).toBe(true)
    expect(await readFile(childPath, "utf8")).toBe(original)
    expect(runMission).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(prepareContinuousBaseline).not.toHaveBeenCalled()
  })
})
