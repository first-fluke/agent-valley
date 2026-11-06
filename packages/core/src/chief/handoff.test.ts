import { describe, expect, it, vi } from "vitest"
import { AgentRunError } from "../domain/ports/agent-runner"
import { createMissionRun } from "./coordinator-run"
import { createMissionContract } from "./coordinator-state"
import { executionPolicySchema } from "./execution"
import { fixture, plan } from "./goal-supervision.fixture"
import { handoffStateSchema } from "./handoff-contract"
import type { Persona } from "./types"

function setup(maxRuns?: number, reviewVendor?: "require" | "prefer") {
  const value = fixture()
  value.mission.executionPolicy = executionPolicySchema.parse(maxRuns ? { maxRuns } : {})
  if (reviewVendor) value.mission.operatingPolicy = { reviewVendor, memory: false }
  const actor = value.mission.personas[0] as Persona
  const discover = vi.fn(async () => ["codex", "claude"])
  value.ports.discoverReadyAgents = discover
  const contract = createMissionContract(value.mission)
  const run = createMissionRun(value.mission, value.ports, contract.assert, () => {})
  return { ...value, actor, discover, run }
}

describe("automatic exhaustion handoff", () => {
  it("discovers an authenticated alternative for the Chief and preserves its original selection and contract", async () => {
    const value = setup()
    value.runAgent.mockRejectedValueOnce(new Error("usage_limit_reached")).mockResolvedValue("final JSON")
    const original = structuredClone(value.mission.personas)
    expect(await value.run(value.actor, "Return strict JSON", "plan")).toBe("final JSON")
    expect(value.discover).toHaveBeenCalledOnce()
    expect(value.runAgent.mock.calls.map((call) => [call[0].id, call[0].agentType, call[0].model])).toEqual([
      ["chief", "codex", "operator-model"],
      ["chief", "claude", undefined],
    ])
    expect(value.mission.personas).toEqual(original)
    expect(value.mission.execution?.runsStarted).toBe(2)
    expect(value.mission.handoff?.exhaustedAgents).toEqual(["codex"])
    expect(value.snapshots.some((snapshot) => snapshot.handoff?.routes.chief?.agentType === "claude")).toBe(true)
    const prompt = value.runAgent.mock.calls[1]?.[1]
    expect(prompt).toContain("Return strict JSON")
    expect(prompt).toContain(value.mission.goal)
    expect(prompt).toContain("AV session handoff")
    handoffStateSchema.parse(value.mission.handoff)
  })

  it("continues context exhaustion once in a fresh session without changing vendor or model", async () => {
    const value = setup()
    value.runAgent.mockRejectedValueOnce(new Error("context_length_exceeded")).mockResolvedValue("continued")
    expect(await value.run(value.actor, "Inspect existing files", "review")).toBe("continued")
    expect(value.discover).not.toHaveBeenCalled()
    expect(value.runAgent.mock.calls[1]?.[0]).toEqual(value.actor)
    expect(value.runAgent.mock.calls[1]?.[4]?.handoff).toContain("fresh session")
    expect(value.mission.execution?.runsStarted).toBe(2)
  })

  it("persists context continuation allowance and effective route across coordinator restarts", async () => {
    const value = setup()
    value.runAgent.mockRejectedValue(new Error("context window exceeded"))
    await expect(value.run(value.actor, "Review", "review")).rejects.toMatchObject({ kind: "handoff-unavailable" })
    expect(value.runAgent).toHaveBeenCalledTimes(2)
    const saved = value.snapshots.at(-1)
    expect(saved?.handoff?.continuations["chief:review::codex"]).toBe(1)
    expect(saved?.handoff?.routes.chief?.model).toBe("operator-model")
    if (!saved) throw new Error("Missing handoff checkpoint")
    const resumed = createMissionRun(
      saved,
      value.ports,
      () => {},
      () => {},
    )
    await expect(resumed(value.actor, "Review", "review")).rejects.toMatchObject({ kind: "handoff-unavailable" })
    expect(value.runAgent).toHaveBeenCalledTimes(3)
    expect(value.runAgent.mock.calls[2]?.[1]).toContain("Saved checkpoint")
  })

  it("does not retry an exhausted provider when another Actor shares that provider", async () => {
    const value = setup()
    value.runAgent.mockRejectedValueOnce(new Error("insufficient_quota")).mockResolvedValue("ok")
    await value.run(value.actor, "Plan", "plan")
    await value.run({ ...value.actor, id: "another-actor" }, "Review", "review")
    expect(value.runAgent.mock.calls[2]?.[0]).toMatchObject({ id: "another-actor", agentType: "claude" })
    expect(value.runAgent.mock.calls.filter((call) => call[0].agentType === "codex")).toHaveLength(1)
  })

  it("tries each authenticated provider once and pauses after all allowances are exhausted", async () => {
    const value = setup()
    value.discover.mockResolvedValue(["codex", "claude", "qwen"])
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    await expect(value.run(value.actor, "Plan", "plan")).rejects.toMatchObject({ kind: "handoff-unavailable" })
    expect(value.runAgent.mock.calls.map((call) => call[0].agentType)).toEqual(["codex", "claude", "qwen"])
    expect(value.snapshots.at(-1)?.handoff?.exhaustedAgents).toEqual(["codex", "claude", "qwen"])
    expect(value.mission.execution?.runsStarted).toBe(3)
  })

  it("uses fresh discovery rather than an unconfirmed or stale planning pool", async () => {
    const value = setup()
    value.mission.availableAgents = ["codex", "grok"]
    value.discover.mockResolvedValue([])
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    await expect(value.run(value.actor, "Plan", "plan")).rejects.toMatchObject({ kind: "handoff-unavailable" })
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.snapshots.at(-1)?.handoff?.exhaustedAgents).toEqual(["codex"])
  })

  it("retains the actual failed runtime route instead of exhausting the originally assigned vendor", async () => {
    const value = setup()
    const attempt = {
      id: "attempt",
      issueId: value.mission.id,
      workspacePath: value.mission.workspace.path,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      agentOutput: null,
    }
    value.runAgent
      .mockImplementationOnce(async () => {
        value.mission.operations = {
          runs: [
            {
              runId: "attempt",
              stage: "work",
              actorId: "chief",
              actorType: "qwen",
              startedAt: attempt.startedAt,
              finishedAt: attempt.finishedAt,
              elapsedMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              outcome: "failed",
              executionState: "settled",
            },
          ],
          routingEvidence: [],
          reviewDecisions: [],
        }
        throw new AgentRunError("usage_limit_reached", attempt)
      })
      .mockResolvedValue("ok")
    await value.run(value.actor, "Work", "work")
    expect(value.mission.handoff?.exhaustedAgents).toEqual(["qwen"])
    expect(value.runAgent.mock.calls[1]?.[0].agentType).toBe("codex")
  })

  it("enforces the saved call budget before starting the replacement session", async () => {
    const value = setup(1)
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    await expect(value.run(value.actor, "Plan", "plan")).rejects.toMatchObject({ kind: "budget" })
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.execution?.runsStarted).toBe(1)
  })

  it.each(["HTTP 429 rate limit reached", "HTTP 401 expired token", "Task max token budget reached"])(
    "does not switch providers for %s",
    async (reason) => {
      const value = setup()
      value.runAgent.mockRejectedValue(new Error(reason))
      await expect(value.run(value.actor, "Plan", "plan")).rejects.toThrow()
      expect(value.discover).not.toHaveBeenCalled()
      expect(value.runAgent).toHaveBeenCalledOnce()
    },
  )

  it("does not replay an external effect after a provider failure", async () => {
    const value = setup()
    value.mission.plan = {
      tasks: [
        {
          id: "publish",
          title: "Publish",
          personaId: "chief",
          instructions: "Publish once",
          acceptance: ["Published"],
          dependencies: [],
          effectScope: "external",
        },
      ],
    }
    value.mission.tasks = [{ id: "publish", reviewerId: "reviewer", status: "pending", attempts: 0 }]
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    await expect(value.run(value.actor, "Publish", "work", "publish")).rejects.toMatchObject({ kind: "unknown-effect" })
    expect(value.discover).not.toHaveBeenCalled()
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
  })

  it("does not hide read-only mutations behind exhaustion recovery", async () => {
    const value = setup()
    value.runAgent.mockImplementation(async () => {
      value.mutate("changed")
      throw new Error("usage_limit_reached")
    })
    await expect(value.run(value.actor, "Plan", "plan")).rejects.toThrow("read-only")
    expect(value.discover).not.toHaveBeenCalled()
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("requires a saved handoff before invoking the replacement", async () => {
    const value = setup()
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    value.ports.save = async (mission) => {
      if (mission.handoff) throw new Error("disk full")
    }
    await expect(value.run(value.actor, "Plan", "plan")).rejects.toThrow("checkpoint could not be saved")
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("retains the required different-provider review after handoff", async () => {
    const value = setup(undefined, "require")
    value.mission.plan = structuredClone(plan)
    value.discover.mockResolvedValue(["cursor", "claude"])
    value.runAgent.mockRejectedValueOnce(new Error("usage_limit_reached")).mockResolvedValue("reviewed")
    expect(await value.run(value.actor, "Review", "review", "onboarding")).toBe("reviewed")
    expect(value.runAgent.mock.calls[1]?.[0].agentType).toBe("claude")
  })

  it("pauses when only the actual worker's provider remains for a required independent review", async () => {
    const value = setup(undefined, "require")
    value.mission.plan = structuredClone(plan)
    value.discover.mockResolvedValue(["cursor"])
    value.runAgent.mockRejectedValue(new Error("usage_limit_reached"))
    await expect(value.run(value.actor, "Review", "gate-review", "onboarding")).rejects.toMatchObject({
      kind: "handoff-unavailable",
    })
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("reports the actual same-provider fallback when cross-provider review is preferred", async () => {
    const value = setup(undefined, "prefer")
    value.mission.plan = structuredClone(plan)
    value.mission.operations = {
      runs: [],
      routingEvidence: [],
      reviewDecisions: [
        {
          taskId: "onboarding",
          workerActorType: "cursor",
          reviewerId: "chief",
          reviewerActorType: "codex",
          crossVendor: true,
          outcome: "assigned",
          reason: "Original review",
        },
      ],
    }
    value.discover.mockResolvedValue(["cursor"])
    value.runAgent.mockRejectedValueOnce(new Error("usage_limit_reached")).mockResolvedValue("reviewed")
    await value.run(value.actor, "Review", "review", "onboarding")
    expect(value.mission.operations.reviewDecisions[0]).toMatchObject({
      reviewerActorType: "cursor",
      crossVendor: false,
    })
  })
})
