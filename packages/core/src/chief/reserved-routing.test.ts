import { describe, expect, it } from "vitest"
import { chiefConfigSchema, chiefOperatingPolicy } from "../config/chief-schema"
import { fixture } from "./goal-supervision.fixture"
import type { ChiefOperatingPolicy, ChiefOperations, OperatingRun } from "./operations"
import { selectWorkActor, workActorCandidates } from "./routing"
import type { Persona } from "./types"

function setup() {
  const mission = fixture().mission
  mission.availableAgents = ["codex", "claude", "grok"]
  mission.availableSkills = []
  const operatingPolicy: ChiefOperatingPolicy = {
    reviewVendor: "off",
    memory: true,
    readyActors: ["codex", "claude", "grok"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.5,
      candidates: [
        { actorType: "codex" },
        { actorType: "claude", model: "opus" },
        { actorType: "grok", skills: ["oma-qa"] },
      ],
    },
  }
  const operations: ChiefOperations = { runs: [], routingEvidence: [], reviewDecisions: [] }
  return Object.assign(mission, { operatingPolicy, operations })
}

const actor = (id: string, skills: string[]): Persona => ({ id, name: id, role: "Work", agentType: "codex", skills })

function run(overrides: Partial<OperatingRun>): OperatingRun {
  return {
    runId: "attempt",
    taskId: "qa",
    stage: "work",
    actorId: "qa",
    actorType: "grok",
    startedAt: "2026-11-23T00:00:00Z",
    finishedAt: "2026-11-23T00:00:01Z",
    elapsedMs: 1000,
    inputTokens: 1000,
    outputTokens: 2000,
    costUsd: 0.005,
    outcome: "passed",
    ...overrides,
  }
}

describe("routes reserved for skills", () => {
  it("starts an Actor whose every skill is named on its reserved route", () => {
    const mission = setup()
    const selected = selectWorkActor(mission, actor("qa", ["oma-qa"]), "qa")
    expect(selected.actor).toMatchObject({ id: "qa", agentType: "grok" })
    expect(selected.reason).toContain("reserved")
  })

  it("keeps every other Actor off the reserved route", () => {
    const mission = setup()
    for (const skills of [[], ["oma-backend"], ["oma-backend", "oma-qa"]]) {
      const worker = actor("worker", skills)
      expect(workActorCandidates(mission, worker).map((candidate) => candidate.actorType)).toEqual(["codex", "claude"])
      expect(selectWorkActor(mission, worker, "build").actor.agentType).not.toBe("grok")
    }
  })

  it("repairs a rejected delivery on the reserved route", () => {
    const mission = setup()
    mission.operations.runs.push(run({ outcome: "rejected" }))
    expect(selectWorkActor(mission, actor("qa", ["oma-qa"]), "qa").actor.agentType).toBe("grok")
  })

  it("leaves the reserved route for a shared one after a run that could not finish", () => {
    const mission = setup()
    mission.operations.runs.push(run({ outcome: "failed" }))
    const selected = selectWorkActor(mission, actor("qa", ["oma-qa"]), "qa")
    expect(selected.actor.agentType).not.toBe("grok")
    expect(selected.reason).toContain("Escalated")
  })

  it("uses the shared routes while the reserved vendor is not ready", () => {
    const mission = setup()
    mission.operatingPolicy.readyActors = ["codex", "claude"]
    expect(selectWorkActor(mission, actor("qa", ["oma-qa"]), "qa").actor.agentType).not.toBe("grok")
  })

  it("carries the skills of a configured candidate into the operating policy", () => {
    const config = chiefConfigSchema.parse({
      routing: { candidates: [{ actor_type: "codex" }, { actor_type: "grok", skills: ["oma-qa"] }] },
    })
    expect(chiefOperatingPolicy(config, ["codex", "grok"]).routing?.candidates).toEqual([
      { actorType: "codex" },
      { actorType: "grok", skills: ["oma-qa"] },
    ])
  })
})
