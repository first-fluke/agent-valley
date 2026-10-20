import { describe, expect, it } from "vitest"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { planPrompt } from "./prompts"
import { parsePlanningResponse } from "./schemas"

describe("required OMA task assignments", () => {
  it.each([true, false])("rejects unskilled task Actors with supervision: %s", (supervised) => {
    const { mission } = fixture()
    mission.oma = true
    if (!supervised) delete mission.supervision
    const source = JSON.stringify({ ...plan, ...(supervised ? { goalBrief: brief } : {}) })
    expect(() => parsePlanningResponse(source, mission)).toThrow("onboarding requires an OMA-skilled Actor")
    expect(planPrompt(mission)).toContain("OMA is required")
  })

  it("accepts relevant skill assignments and preserves explicitly disabled OMA behavior", () => {
    const { mission } = fixture()
    const source = JSON.stringify({ ...plan, goalBrief: brief })
    expect(parsePlanningResponse(source, mission).plan).toEqual(plan)
    mission.oma = true
    const worker = mission.personas.find((entry) => entry.id === "worker")
    if (!worker) throw new Error("Expected fixture worker")
    worker.skills = ["oma-backend"]
    expect(parsePlanningResponse(source, mission).plan).toEqual(plan)
  })

  it("requires skilled work even without receipt mode when the installed catalog is present", () => {
    const { mission } = fixture()
    mission.oma = false
    mission.availableSkills = [
      { name: "oma-backend", description: "Backend", path: "/workspace/.agents/skills/oma-backend/SKILL.md" },
    ]
    expect(() => parsePlanningResponse(JSON.stringify({ ...plan, goalBrief: brief }), mission)).toThrow(
      "OMA-skilled Actor",
    )
  })
})
