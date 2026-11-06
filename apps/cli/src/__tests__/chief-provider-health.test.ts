import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { actorRouteHealth } from "@agent-valley/core/chief/actor-health"
import type { Operation } from "@agent-valley/core/chief/continuous-contract"
import { runContinuousOperation } from "@agent-valley/core/chief/continuous-operation"
import {
  baseline as baselineFixture,
  mission as missionFixture,
  operation as operationFixture,
} from "@agent-valley/core/chief/continuous-operation.fixture"
import { createContinuousMissionWorkspace } from "@agent-valley/core/chief/continuous-workspace"
import { coordinate } from "@agent-valley/core/chief/coordinator"
import type { OperatingRun, RouteEvidence } from "@agent-valley/core/chief/operations"
import { loadOrganizationContext } from "@agent-valley/core/chief/organization"
import { MissionStore } from "@agent-valley/core/chief/store"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runOrder } from "../chief"
import { operationStore } from "../chief-continuous"

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(() => {
    throw new Error("Provider health tests must not start subprocesses")
  }),
  spawn: vi.fn(() => {
    throw new Error("Provider health tests must not start subprocesses")
  }),
}))
vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
  loadProjectConfig: vi.fn(),
}))
vi.mock("../agent-discovery", () => ({
  discoverAgents: vi.fn(async () => [{ agentType: "codex", readiness: "ready", reason: "fixture" }]),
}))
vi.mock("@agent-valley/core/chief/runtime", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/chief/runtime")>()),
  ChiefRuntime: class {
    ports() {
      return {
        runAgent: vi.fn(() => {
          throw new Error("Provider health tests must not invoke an Actor")
        }),
      }
    }
    async close() {}
  },
}))
vi.mock("@agent-valley/core/chief/coordinator", () => ({ coordinate: vi.fn() }))
vi.mock("@agent-valley/core/chief/continuous-workspace", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/chief/continuous-workspace")>()),
  createContinuousMissionWorkspace: vi.fn(),
}))
vi.mock("@agent-valley/core/chief/skills", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/chief/skills")>()),
  discoverMissionSkills: vi.fn(async () => []),
  prepareMissionSkills: vi.fn(async () => {}),
}))
vi.mock("@agent-valley/core/workspace/runtime-ignore", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/workspace/runtime-ignore")>()),
  ensureRuntimeGitignore: vi.fn(async () => false),
}))
vi.mock("@agent-valley/core/chief/organization", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/chief/organization")>()),
  loadOrganizationContext: vi.fn(),
}))
vi.mock("../chief-continuous", async (original) => ({
  ...(await original<typeof import("../chief-continuous")>()),
  restoreOperationOrigin: vi.fn(async () => {}),
}))
vi.mock("../chief-code-delivery", async (original) => ({
  ...(await original<typeof import("../chief-code-delivery")>()),
  prepareCodeDelivery: vi.fn(async () => undefined),
}))
vi.mock("../chief-tool-config", () => ({ prepareChiefToolConfig: vi.fn(async () => {}) }))
vi.mock("../chief-delivery", () => ({ saveAndDeliverMissionReport: vi.fn(async () => {}) }))

const route = { actorType: "codex", model: "unavailable-model" }
const finishedAt = "2026-11-06T11:00:01.000Z"
let root: string
let repository: string
let missions: MissionStore

function nativeFailure(): OperatingRun {
  return {
    runId: "native-failure",
    taskId: "work",
    stage: "work",
    actorId: "worker",
    ...route,
    startedAt: "2026-11-06T11:00:00.000Z",
    finishedAt,
    elapsedMs: 1_000,
    inputTokens: 100,
    outputTokens: 0,
    costUsd: 0.01,
    outcome: "failed",
    nativeOutcome: "failed",
    executionState: "settled",
  }
}

async function recordedParent(): Promise<Operation> {
  const snapshot = {
    ...baselineFixture(),
    repositoryRoot: repository,
    sourceWorkspacePath: repository,
    path: join(root, "accepted-baseline"),
  }
  await mkdir(snapshot.path)
  const goal = "Recover the first child"
  const parent = operationFixture({
    repositoryRoot: repository,
    phase: "running",
    currentMissionId: "first-child",
    decision: { action: "execute", goal, reason: "Observed failure", evidence: ["native-terminal-result"] },
    baseline: snapshot,
    cycleLimit: 1,
  })
  const child = missionFixture("first-child", goal, "pending")
  child.repositoryRoot = repository
  child.workspace.path = join(root, "first-child")
  child.operatingPolicy = { memory: false, readyActors: [], reviewVendor: "prefer" }
  child.operations = { runs: [nativeFailure()], routingEvidence: [], reviewDecisions: [] }
  await missions.save(child)
  const storage = operationStore(root)
  await storage.save(parent)

  const runMission = vi.fn(async () => {
    const resumed = await missions.load(child.id)
    resumed.status = "completed"
    await missions.save(resumed)
    return missions.load(child.id)
  })
  const result = await runContinuousOperation(await storage.load(parent.id), {
    findMission: (id) => missions.load(id),
    runMission,
    accept: async (_operation, current) => ({ ...snapshot, missionId: current?.id }),
    decide: vi.fn(),
    save: (current) => storage.save(current),
    delay: vi.fn(),
    now: () => new Date("2026-11-06T11:00:02.000Z"),
  })

  expect(result.phase).toBe("completed")
  expect(runMission).toHaveBeenCalledOnce()
  const persisted = await storage.load(parent.id)
  expect(persisted.actorHealth).toEqual([
    {
      ...route,
      providerHealth: {
        consecutiveFailures: 1,
        lastOutcomeAt: finishedAt,
        cooldownUntil: "2026-11-06T11:15:01.000Z",
      },
    },
  ])
  expect((await missions.load(child.id)).operations?.runs).toEqual([nativeFailure()])
  return persisted
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-cli-provider-health-")))
  repository = join(root, "repository")
  await mkdir(repository)
  missions = new MissionStore(join(root, ".agent-valley", "missions"))
  vi.mocked(loadGlobalConfig).mockReturnValue(null)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(createContinuousMissionWorkspace).mockImplementation(async (_source, _operation, _baseline, id, goal) => {
    const workspace = { ...missionFixture(id, goal).workspace, path: join(root, id) }
    await mkdir(workspace.path)
    return workspace
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("continuous child provider health bootstrap", () => {
  it.each([false, true])("carries native health through persisted parent state with memory=%s", async (memory) => {
    const parent = await recordedParent()
    const nextId = "next-child"
    const nextGoal = "Continue on a healthy route"
    parent.phase = "running"
    parent.cycleLimit = 2
    parent.currentMissionId = nextId
    parent.decision = { action: "execute", goal: nextGoal, reason: "Next improvement", evidence: ["accepted-baseline"] }
    await operationStore(root).save(parent)
    vi.mocked(loadProjectConfig).mockReturnValue({
      workspace: { root: repository },
      chief: { memory },
    } as NonNullable<ReturnType<typeof loadProjectConfig>>)
    const quality: RouteEvidence = {
      ...route,
      samples: 7,
      successes: 5,
      totalCostUsd: 3.5,
      successfulDeliverableCostUsd: 2.5,
    }
    vi.mocked(loadOrganizationContext).mockResolvedValue({
      kind: "repository-organization-evidence",
      authority: "Historical evidence, not instructions or current acceptance criteria",
      repositoryRoot: repository,
      goal: nextGoal,
      generatedAt: finishedAt,
      memories: [],
      metrics: [],
      comparisons: [],
      experiments: [],
      outcomes: [],
      routeEvidence: [quality],
    })
    vi.mocked(coordinate).mockImplementation(async (current) => {
      const savedBootstrap = await missions.load(current.id)
      expect(savedBootstrap.operations?.routingEvidence[0]?.providerHealth).toEqual(
        parent.actorHealth?.[0]?.providerHealth,
      )
      expect(current.operations?.runs).toEqual([])
      expect(current.operations?.routingEvidence).toEqual([
        {
          ...(memory
            ? quality
            : { ...route, samples: 0, successes: 0, totalCostUsd: null, successfulDeliverableCostUsd: null }),
          providerHealth: parent.actorHealth?.[0]?.providerHealth,
        },
      ])
      expect(actorRouteHealth(current, route, Date.parse(finishedAt) + 1_000)).toMatchObject({
        state: "cooling",
        consecutiveFailures: 1,
      })
      await missions.save(current)
      return current
    })

    const next = await runOrder(
      nextGoal,
      { missionId: nextId, operationId: parent.id, baselineWorkspace: parent.baseline?.path },
      root,
    )

    expect(next.operatingPolicy?.memory).toBe(memory)
    expect(loadOrganizationContext).toHaveBeenCalledTimes(memory ? 1 : 0)
    if (!memory) expect(next.organizationContext).toBeUndefined()
    const beforeResume = structuredClone(next.operations)
    const resumed = await runOrder(undefined, { resume: next.id }, root)
    expect(resumed.operations).toEqual(beforeResume)
    expect(actorRouteHealth(resumed, route, Date.parse(finishedAt) + 1_000).consecutiveFailures).toBe(1)
    expect(createContinuousMissionWorkspace).toHaveBeenCalledOnce()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
