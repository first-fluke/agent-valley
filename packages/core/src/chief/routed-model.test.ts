import { describe, expect, it } from "vitest"
import { fixture, plan } from "./goal-supervision.fixture"
import { selectTaskReviewer } from "./review-routing"
import { withRoutedModel } from "./routing"
import type { Mission, Persona } from "./types"

function claudeReviewer(): Persona {
  return { id: "review-claude", name: "Claude reviewer", role: "Review", agentType: "claude", skills: [] }
}

/** Codex is first in the routing order and Claude carries the operator's model. */
function mission(): Mission {
  const { mission } = fixture()
  mission.personas.push(claudeReviewer())
  mission.operatingPolicy = {
    memory: false,
    reviewVendor: "off",
    readyActors: ["codex", "claude"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.5,
      candidates: [{ actorType: "codex" }, { actorType: "claude", model: "opus" }],
    },
  }
  return mission
}

describe("the routing candidate's model for automatic Actors", () => {
  it("gives an Actor without a model the model configured for its CLI", () => {
    const value = mission()
    expect(withRoutedModel(value, claudeReviewer())).toEqual({ ...claudeReviewer(), model: "opus" })
    // The stored roster is not changed: automatic Actors may not record a model.
    expect(value.personas.find((actor) => actor.id === "review-claude")?.model).toBeUndefined()
  })

  it("keeps an explicit model, an unconfigured CLI and the operator's Chief Director as they are", () => {
    const value = mission()
    const explicit = { ...claudeReviewer(), model: "sonnet" }
    expect(withRoutedModel(value, explicit)).toBe(explicit)
    const codex: Persona = { id: "worker-codex", name: "Worker", role: "Work", agentType: "codex", skills: [] }
    expect(withRoutedModel(value, codex)).toBe(codex)
    const chief = { ...claudeReviewer(), id: value.chiefId }
    expect(withRoutedModel(value, chief)).toBe(chief)
    value.operatingPolicy = undefined
    expect(withRoutedModel(value, claudeReviewer()).model).toBeUndefined()
  })

  it("reviews on the configured model when the review vendor policy is off", () => {
    const value = mission()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected a fixture task")
    value.plan = { tasks: [{ ...task, personaId: "chief" }] }
    value.tasks = [{ id: task.id, reviewerId: "review-claude", status: "reviewing", attempts: 1 }]
    const state = value.tasks[0]
    if (!state) throw new Error("Expected a fixture task state")
    const reviewer = selectTaskReviewer(value, { ...task, personaId: "chief" }, state)
    expect(reviewer).toMatchObject({ id: "review-claude", agentType: "claude", model: "opus" })
  })
})
