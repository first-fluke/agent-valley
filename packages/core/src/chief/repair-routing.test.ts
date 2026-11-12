import { describe, expect, it } from "vitest"
import { selectRepairTaskId } from "./coordinator-state"
import { fixture, plan } from "./goal-supervision.fixture"
import { BUILD_AUTHORIZATION_RULE, HANDOFF_PATH_RULE, planPrompt, reviewPrompt, workPrompt } from "./prompts"
import type { ChiefTaskState } from "./types"

function missionWithGates() {
  const { mission } = fixture()
  mission.personas = [
    ...mission.personas,
    { id: "backend", name: "Backend", role: "Implement", agentType: "codex", skills: ["oma-backend"] },
    { id: "planner", name: "Planner", role: "Bind evidence", agentType: "codex", skills: ["oma-pm", "oma-qa"] },
  ]
  const first = structuredClone(plan.tasks[0])
  if (!first) throw new Error("Expected a task")
  mission.plan = {
    tasks: [
      first,
      { ...first, id: "implement", title: "Implement", personaId: "backend", dependencies: [] },
      { ...first, id: "gates", title: "Bind evidence", personaId: "planner", dependencies: [] },
    ],
  }
  return mission
}

describe("verification repair routing", () => {
  it("prefers the latest code-capable task when the failure names no task", () => {
    const mission = missionWithGates()
    expect(selectRepairTaskId(mission, "FAIL: coverage gate exited 1")).toBe("implement")
  })

  it("keeps explicit task references and gate rejections", () => {
    const mission = missionWithGates()
    expect(selectRepairTaskId(mission, "Task gates exhausted repairs")).toBe("gates")
    expect(selectRepairTaskId(mission, undefined, "onboarding")).toBe("onboarding")
  })

  it("falls back to the last task when no Actor has code skills", () => {
    const { mission } = fixture()
    mission.plan = { tasks: [...plan.tasks] }
    expect(selectRepairTaskId(mission, "FAIL: gate")).toBe("onboarding")
  })
})

describe("build authorization in prompts", () => {
  it("tells planners and Actors that an authorized build goal is an explicit build request", () => {
    const mission = missionWithGates()
    const task = mission.plan?.tasks[1]
    const persona = mission.personas.find((entry) => entry.id === "backend")
    if (!task || !persona) throw new Error("Expected fixture task and persona")
    const state: ChiefTaskState = { id: task.id, reviewerId: "reviewer", status: "running", attempts: 1 }
    expect(planPrompt(mission)).toContain(BUILD_AUTHORIZATION_RULE)
    expect(workPrompt(mission, task, state, persona)).toContain(BUILD_AUTHORIZATION_RULE)
  })

  it("tells planners, Actors and task reviewers that ignored paths are never handed off", () => {
    const mission = missionWithGates()
    const task = mission.plan?.tasks[1]
    const persona = mission.personas.find((entry) => entry.id === "backend")
    if (!task || !persona) throw new Error("Expected fixture task and persona")
    const state: ChiefTaskState = { id: task.id, reviewerId: "reviewer", status: "running", attempts: 1 }
    expect(HANDOFF_PATH_RULE).toContain("no separate artifact channel")
    expect(planPrompt(mission)).toContain(HANDOFF_PATH_RULE)
    expect(workPrompt(mission, task, state, persona)).toContain(HANDOFF_PATH_RULE)
    expect(reviewPrompt(mission, task, state)).toContain(HANDOFF_PATH_RULE)
    expect(reviewPrompt(mission)).not.toContain(HANDOFF_PATH_RULE)
  })
})
