import { describe, expect, it, vi } from "vitest"
import { createMissionRun } from "./coordinator-run"
import { classifyFailure, executionPolicySchema, isUnavailableAgentModel } from "./execution"
import { fixture, passed, plan } from "./goal-supervision.fixture"
import { selectTaskReviewer } from "./review-routing"
import type { ChiefTaskState } from "./types"

function setup() {
  const value = fixture()
  const chief = value.mission.personas[0]
  const worker = value.mission.personas[1]
  const reviewer = value.mission.personas[2]
  if (!chief || !worker || !reviewer) throw new Error("Missing fixture Actors")
  chief.agentType = "grok"
  chief.model = "selected-chief"
  worker.agentType = "codex"
  reviewer.agentType = "opencode"
  value.mission.plan = structuredClone(plan)
  value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 10 })
  value.mission.operatingPolicy = {
    reviewVendor: "prefer",
    memory: false,
    readyActors: ["codex", "qwen", "opencode"],
  }
  const state: ChiefTaskState = {
    id: "onboarding",
    reviewerId: reviewer.id,
    status: "reviewing",
    attempts: 1,
    output: "Existing successful worker output; inspect this deliverable",
  }
  value.mission.tasks = [state]
  const discover = vi.fn(async () => ["codex", "qwen", "opencode"])
  value.ports.discoverReadyAgents = discover
  const run = createMissionRun(
    value.mission,
    value.ports,
    () => {},
    () => {},
  )
  return { ...value, chief, worker, reviewer, state, discover, run }
}

describe("unavailable native model recovery", () => {
  it.each(["Model temporarily unavailable", "HTTP 429 Too Many Requests", "Database model is unavailable."])(
    "does not quarantine a provider for unrelated or transient failures: %s",
    (reason) => expect(isUnavailableAgentModel(reason)).toBe(false),
  )
  it.each([
    "Upstream request failed: Model is unavailable.",
    "ModelNotFoundError: selected model",
    "model_not_available",
  ])("classifies explicit model unavailability without provider backoff: %s", (reason) =>
    expect(classifyFailure(reason)).toBe("environment"),
  )

  it("moves only the failed review to another authenticated provider and preserves the successful work", async () => {
    const value = setup()
    const originalOutput = value.state.output
    const originalRoster = structuredClone(value.mission.personas)
    value.runAgent
      .mockRejectedValueOnce(new Error("Upstream request failed: Model is unavailable."))
      .mockResolvedValue(passed)

    await expect(
      value.run(value.reviewer, "Independently inspect existing files", "review", value.state.id),
    ).resolves.toBe(passed)

    expect(value.runAgent.mock.calls.map(([actor, , , stage]) => [actor.agentType, stage])).toEqual([
      ["opencode", "review"],
      ["qwen", "review"],
    ])
    expect(value.state.attempts).toBe(1)
    expect(value.state.output).toBe(originalOutput)
    expect(value.state.repairRound).toBeUndefined()
    expect(value.mission.personas).toEqual(originalRoster)
    expect(value.mission.handoff?.unavailableAgents).toEqual(["opencode"])
    expect(value.mission.handoff?.exhaustedAgents).toEqual([])
    expect(value.mission.execution).toMatchObject({ runsStarted: 2, retries: 0 })
    const task = value.mission.plan?.tasks[0]
    if (!task) throw new Error("Missing fixture task")
    const nextReviewer = selectTaskReviewer(value.mission, task, value.state)
    expect(nextReviewer.agentType).toBe("qwen")
    await value.run(nextReviewer, "Review a different task", "review", value.state.id)
    expect(value.runAgent.mock.calls.filter(([actor]) => actor.agentType === "opencode")).toHaveLength(1)
  })

  it("does not replace the selected Chief when its model is unavailable", async () => {
    const value = setup()
    value.runAgent.mockRejectedValue(new Error("Upstream request failed: Model is unavailable."))

    await expect(value.run(value.chief, "Return the original plan", "plan")).rejects.toMatchObject({
      kind: "chief-unavailable",
    })

    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.discover).not.toHaveBeenCalled()
    expect(value.chief).toMatchObject({ agentType: "grok", model: "selected-chief" })
  })

  it("tries unused catalog-discovered free OpenCode models before switching the reviewer provider", async () => {
    const value = setup()
    const catalog = vi.fn(async () => ({
      defaultModel: "opencode/broken-free",
      models: ["opencode/broken-free", "opencode/alternate-free", "opencode/final-free"],
    }))
    value.ports.discoverFreeModels = catalog
    value.runAgent
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockResolvedValue(passed)

    await value.run(value.reviewer, "Review existing work", "review", value.state.id)

    expect(value.runAgent.mock.calls.map(([actor]) => [actor.agentType, actor.model])).toEqual([
      ["opencode", undefined],
      ["opencode", "opencode/alternate-free"],
      ["opencode", "opencode/final-free"],
    ])
    expect(value.discover).not.toHaveBeenCalled()
    expect(value.mission.handoff?.unavailableModels?.opencode).toEqual([
      "<native-default>",
      "opencode/broken-free",
      "opencode/alternate-free",
    ])
    expect(value.mission.handoff?.unavailableAgents ?? []).not.toContain("opencode")
    expect(value.state).toMatchObject({
      attempts: 1,
      output: "Existing successful worker output; inspect this deliverable",
    })
    expect(catalog).toHaveBeenCalledWith("opencode", value.mission.workspace.path, expect.any(AbortSignal))
    expect(value.mission.execution).toMatchObject({ runsStarted: 3, retries: 0 })
  })

  it("persists per-model failures before cross-provider fallback when every catalog free model fails", async () => {
    const value = setup()
    value.ports.discoverFreeModels = async () => ({
      defaultModel: "opencode/broken-free",
      models: ["opencode/broken-free", "opencode/alternate-free"],
    })
    value.runAgent
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockResolvedValue(passed)

    await value.run(value.reviewer, "Review existing work", "review", value.state.id)

    expect(value.runAgent.mock.calls.map(([actor]) => [actor.agentType, actor.model])).toEqual([
      ["opencode", undefined],
      ["opencode", "opencode/alternate-free"],
      ["qwen", undefined],
    ])
    expect(value.snapshots.at(-1)?.handoff?.unavailableModels?.opencode).toEqual([
      "<native-default>",
      "opencode/broken-free",
      "opencode/alternate-free",
    ])
    expect(value.snapshots.at(-1)?.handoff?.unavailableAgents).toEqual(["opencode"])
  })

  it("tries explicit catalog free models even when the native default cannot be identified", async () => {
    const value = setup()
    value.ports.discoverFreeModels = async () => ({ models: ["opencode/possibly-the-current-free-model"] })
    value.runAgent.mockRejectedValueOnce(new Error("Model is unavailable")).mockResolvedValue(passed)

    await value.run(value.reviewer, "Review existing work", "review", value.state.id)

    expect(value.runAgent.mock.calls.map(([actor]) => [actor.agentType, actor.model])).toEqual([
      ["opencode", undefined],
      ["opencode", "opencode/possibly-the-current-free-model"],
    ])
    expect(value.mission.handoff?.unavailableModels?.opencode).toEqual(["<native-default>"])
  })

  it("retains failed model identities across different Actors and coordinator restarts", async () => {
    const value = setup()
    const catalog = vi.fn(async () => ({
      defaultModel: "opencode/broken-free",
      models: ["opencode/broken-free", "opencode/alternate-free", "opencode/final-free"],
    }))
    value.ports.discoverFreeModels = catalog
    value.runAgent
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockRejectedValueOnce(new Error("Model is unavailable"))
      .mockResolvedValue(passed)
    await value.run(value.reviewer, "Review files", "review", value.state.id)
    const saved = structuredClone(value.mission)
    const resumed = createMissionRun(
      saved,
      value.ports,
      () => {},
      () => {},
    )

    await resumed({ ...value.reviewer, id: "another-reviewer" }, "Review another task", "review", value.state.id)
    await resumed(
      { ...value.reviewer, id: "pinned-failed-reviewer", model: "opencode/alternate-free" },
      "Review again",
      "review",
      value.state.id,
    )

    expect(value.runAgent.mock.calls.map(([actor]) => [actor.agentType, actor.model])).toEqual([
      ["opencode", undefined],
      ["opencode", "opencode/alternate-free"],
      ["opencode", "opencode/final-free"],
      ["opencode", "opencode/final-free"],
      ["opencode", "opencode/final-free"],
    ])
    expect(catalog).toHaveBeenCalledTimes(3)
    expect(saved.handoff?.unavailableModels?.opencode).toEqual([
      "<native-default>",
      "opencode/broken-free",
      "opencode/alternate-free",
    ])
    expect(saved.execution?.runsStarted).toBe(5)
  })

  it("does not persist discovery results or dispatch after cancellation", async () => {
    const value = setup()
    const controller = new AbortController()
    value.ports.signal = controller.signal
    let complete!: (catalog: { models: string[] }) => void
    const catalog = vi.fn(
      () =>
        new Promise<{ models: string[] }>((resolve) => {
          complete = resolve
        }),
    )
    value.ports.discoverFreeModels = catalog
    value.runAgent.mockRejectedValueOnce(new Error("Model is unavailable")).mockResolvedValue(passed)
    const pending = value.run(value.reviewer, "Review", "review", value.state.id)
    const cancellation = new Error("operator cancelled")
    const result = expect(pending).rejects.toBe(cancellation)
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledOnce())
    const snapshots = value.snapshots.length
    const history = structuredClone(value.mission.history)

    controller.abort(cancellation)
    complete({ models: ["opencode/new-free"] })
    await result

    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.snapshots).toHaveLength(snapshots)
    expect(value.mission.history).toEqual(history)
    expect(value.mission.handoff?.routes).toEqual({})
    expect(value.mission.handoff?.unavailableModels).toBeUndefined()
    expect(value.mission.execution?.runsStarted).toBe(1)
  })

  function savedFreeRoute() {
    const value = setup()
    value.mission.handoff = {
      exhaustedAgents: [],
      unavailableModels: { opencode: ["<native-default>", "opencode/broken-free"] },
      freeModels: { opencode: ["opencode/previously-free"] },
      freeRoutes: { [value.reviewer.id]: "opencode/previously-free" },
      routes: { [value.reviewer.id]: { agentType: "opencode", model: "opencode/previously-free" } },
      continuations: {},
    }
    value.runAgent.mockResolvedValue(passed)
    return value
  }

  it("revalidates saved and reused free routes before dispatch and replaces a repriced model", async () => {
    const value = savedFreeRoute()
    const roster = structuredClone(value.mission.personas)
    const policy = structuredClone(value.mission.executionPolicy)
    const catalog = vi.fn(async () => ({ models: ["opencode/current-free"] }))
    value.ports.discoverFreeModels = catalog

    await value.run(value.reviewer, "Review saved work", "review", value.state.id)
    await value.run({ ...value.reviewer, id: "another-reviewer" }, "Review other work", "review", value.state.id)

    expect(catalog).toHaveBeenCalledOnce()
    expect(value.runAgent.mock.calls.map(([actor]) => [actor.agentType, actor.model])).toEqual([
      ["opencode", "opencode/current-free"],
      ["opencode", "opencode/current-free"],
    ])
    expect(value.mission.handoff?.unavailableModels?.opencode).toEqual(["<native-default>", "opencode/broken-free"])
    expect(value.mission.handoff?.freeRoutes?.[value.reviewer.id]).toBe("opencode/current-free")
    expect(value.mission.personas).toEqual(roster)
    expect(value.mission.executionPolicy).toEqual(policy)
    expect(value.mission.execution?.runsStarted).toBe(2)
  })

  it("uses another authenticated provider when a restored free route has no freshly eligible model", async () => {
    const value = savedFreeRoute()
    const catalog = vi.fn(async () => ({ models: [] }))
    value.ports.discoverFreeModels = catalog

    await value.run(value.reviewer, "Review saved work", "review", value.state.id)

    expect(catalog).toHaveBeenCalledOnce()
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.runAgent.mock.calls[0]?.[0]).toMatchObject({ agentType: "qwen", model: undefined })
    expect(value.mission.handoff?.unavailableModels?.opencode).toEqual(["<native-default>", "opencode/broken-free"])
    expect(value.mission.execution?.runsStarted).toBe(1)
  })

  it("pauses before model dispatch when a restored free route has no eligible model or independent provider", async () => {
    const value = savedFreeRoute()
    if (!value.mission.operatingPolicy) throw new Error("Missing fixture policy")
    value.mission.operatingPolicy.reviewVendor = "require"
    value.discover.mockResolvedValue(["codex", "opencode"])
    value.ports.discoverFreeModels = async () => ({ models: [] })

    await expect(value.run(value.reviewer, "Review", "review", value.state.id)).rejects.toMatchObject({
      kind: "handoff-unavailable",
    })

    expect(value.runAgent).not.toHaveBeenCalled()
    expect(value.mission.execution?.runsStarted ?? 0).toBe(0)
    expect(value.mission.handoff?.unavailableModels?.opencode).toEqual(["<native-default>", "opencode/broken-free"])
  })

  it("keeps an explicitly configured paid model as the operator's selection", async () => {
    const value = setup()
    value.reviewer.model = "opencode/operator-selected-paid"
    const catalog = vi.fn(async () => ({ models: [] }))
    value.ports.discoverFreeModels = catalog
    value.runAgent.mockResolvedValue(passed)

    await value.run(value.reviewer, "Review", "review", value.state.id)

    expect(catalog).not.toHaveBeenCalled()
    expect(value.runAgent.mock.calls[0]?.[0]).toMatchObject({ model: "opencode/operator-selected-paid" })
  })

  it("does not treat another Actor's unavailable model as exhaustion of the selected Chief", async () => {
    const value = setup()
    value.chief.agentType = "opencode"
    value.chief.model = "explicit-chief-model"
    value.runAgent
      .mockRejectedValueOnce(new Error("Upstream request failed: Model is unavailable."))
      .mockResolvedValue(passed)
    await value.run(value.reviewer, "Review files", "review", value.state.id)

    await value.run(value.chief, "Plan with the selected Chief model", "plan")

    expect(value.runAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      id: value.chief.id,
      agentType: "opencode",
      model: "explicit-chief-model",
    })
    expect(value.discover).toHaveBeenCalledOnce()
  })

  it("pauses without repeating an unavailable provider when no alternative can review", async () => {
    const value = setup()
    if (!value.mission.operatingPolicy) throw new Error("Missing fixture policy")
    value.mission.operatingPolicy.reviewVendor = "require"
    value.discover.mockResolvedValue(["codex", "opencode"])
    value.runAgent.mockRejectedValue(new Error("Upstream request failed: Model is unavailable."))

    await expect(value.run(value.reviewer, "Review", "review", value.state.id)).rejects.toMatchObject({
      kind: "handoff-unavailable",
    })

    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.snapshots.at(-1)?.handoff?.unavailableAgents).toEqual(["opencode"])
  })
})
