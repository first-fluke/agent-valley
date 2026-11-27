import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baseline as baselineFixture,
  mission as missionFixture,
  operation as operationFixture,
} from "@agent-valley/core/chief/continuous-operation.fixture"
import { createContinuousMissionWorkspace } from "@agent-valley/core/chief/continuous-workspace"
import { MissionStore } from "@agent-valley/core/chief/store"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runOrder } from "../chief"
import { operationStore } from "../chief-continuous"

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(() => {
    throw new Error("Tests must not start subprocesses")
  }),
  spawn: vi.fn(() => {
    throw new Error("Tests must not start subprocesses")
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
          throw new Error("Tests must not invoke an Actor")
        }),
      }
    }
    async close() {}
  },
}))
vi.mock("@agent-valley/core/chief/coordinator", () => ({ coordinate: vi.fn(async (mission) => mission) }))
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

let root: string
let repository: string
let missions: MissionStore

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-cli-child-exhaustion-")))
  repository = join(root, "repository")
  await mkdir(repository)
  missions = new MissionStore(join(root, ".agent-valley", "missions"))
  vi.mocked(loadGlobalConfig).mockReturnValue(null)
  vi.mocked(loadProjectConfig).mockReturnValue({
    workspace: { root: repository },
  } as NonNullable<ReturnType<typeof loadProjectConfig>>)
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

describe("child execution mission exhaustion seeding", () => {
  it("populates mission.handoff.exhaustedAgents for fresh child under operation with recent exhaustedProviders", async () => {
    const parent = operationFixture({
      id: "op-recent",
      repositoryRoot: repository,
      settings: { workspace: repository, actor: "codex", model: "pinned-model" },
      baseline: {
        ...baselineFixture(),
        operationId: "op-recent",
        repositoryRoot: repository,
        path: join(root, "baseline-recent"),
      },
      exhaustedProviders: [{ agentType: "codex", at: new Date().toISOString() }],
    })
    parent.currentMissionId = "child-recent"
    parent.decision = { action: "execute", goal: "Recent exhaustion child", reason: "Improve", evidence: ["baseline"] }
    await operationStore(root).save(parent)

    const mission = await runOrder(
      "Recent exhaustion child",
      {
        missionId: "child-recent",
        operationId: parent.id,
        baselineWorkspace: parent.baseline?.path,
      },
      root,
    )

    expect(mission.handoff?.exhaustedAgents).toEqual(["codex"])
    const saved = await missions.load("child-recent")
    expect(saved.handoff?.exhaustedAgents).toEqual(["codex"])
  })

  it("does not seed expired entries beyond the exhaustion window", async () => {
    const expiredAt = new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString()
    const parent = operationFixture({
      id: "op-expired",
      repositoryRoot: repository,
      settings: { workspace: repository, actor: "codex", model: "pinned-model" },
      baseline: {
        ...baselineFixture(),
        operationId: "op-expired",
        repositoryRoot: repository,
        path: join(root, "baseline-expired"),
      },
      exhaustedProviders: [{ agentType: "codex", at: expiredAt }],
    })
    parent.currentMissionId = "child-expired"
    parent.decision = { action: "execute", goal: "Expired exhaustion child", reason: "Improve", evidence: ["baseline"] }
    await operationStore(root).save(parent)

    const mission = await runOrder(
      "Expired exhaustion child",
      {
        missionId: "child-expired",
        operationId: parent.id,
        baselineWorkspace: parent.baseline?.path,
      },
      root,
    )

    expect(mission.handoff).toBeUndefined()
    const saved = await missions.load("child-expired")
    expect(saved.handoff).toBeUndefined()
  })

  it("preserves existing handoff state when resuming a saved child mission", async () => {
    const childId = "child-resumed"
    const savedChild = missionFixture(childId, "Resumed child", "paused")
    savedChild.repositoryRoot = repository
    savedChild.workspace.path = join(root, childId)
    await mkdir(savedChild.workspace.path, { recursive: true })
    savedChild.handoff = {
      exhaustedAgents: ["qwen"],
      routes: {},
      continuations: {},
    }
    await missions.save(savedChild)

    const resumed = await runOrder(undefined, { resume: childId }, root)
    expect(resumed.handoff?.exhaustedAgents).toEqual(["qwen"])
    const persisted = await missions.load(childId)
    expect(persisted.handoff?.exhaustedAgents).toEqual(["qwen"])
  })
})
