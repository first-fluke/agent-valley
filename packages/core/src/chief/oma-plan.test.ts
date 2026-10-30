import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
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
  function fixedMission() {
    const result = fixture()
    result.mission.oma = false
    result.mission.availableSkills = [
      { name: "oma-backend", description: "Backend", path: "/workspace/.agents/skills/oma-backend/SKILL.md" },
    ]
    return result
  }

  it("lets the Chief assign catalog skills without replacing fixed Actor identities", async () => {
    const { mission, ports, runAgent } = fixedMission()
    const response = { ...plan, goalBrief: brief, actorSkills: { worker: ["oma-backend"] } }
    const before = structuredClone(mission)
    const parsed = parsePlanningResponse(JSON.stringify(response), mission)
    expect(mission).toEqual(before)
    expect(parsed.personas).toEqual(
      before.personas.map((actor) => ({
        ...actor,
        skills: actor.id === "worker" ? ["oma-backend"] : actor.skills,
      })),
    )
    expect(planPrompt(mission)).toContain('"actorSkills":{"existing-actor-id":["installed-skill-name"]}')
    runAgent.mockImplementationOnce(async () => JSON.stringify(response))
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.personas.find((actor) => actor.id === "worker")?.skills).toEqual(["oma-backend"])
  })

  it.each([
    [{ absent: ["oma-backend"] }, "Unknown fixed Actor"],
    [{ worker: ["oma-invented"] }, "installed skill catalog"],
    [{ worker: ["oma-backend", "oma-backend"] }, "Duplicate Actor skill"],
  ])("rejects invalid fixed Actor skill assignments %j", (actorSkills, message) => {
    const { mission } = fixedMission()
    const before = structuredClone(mission)
    expect(() => parsePlanningResponse(JSON.stringify({ ...plan, goalBrief: brief, actorSkills }), mission)).toThrow(
      message,
    )
    expect(mission).toEqual(before)
  })
})
