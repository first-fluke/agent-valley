import { describe, expect, it } from "vitest"
import { actorData, actorPlanData } from "./actor-contract"
import { coordinate } from "./coordinator"
import { CDO_ROLE, DESIGN_DIRECTOR_ROLE } from "./design-lead"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { CMO_ROLE, MARKETING_DIRECTOR_ROLE } from "./marketing-lead"
import { CHIEF_DIRECTOR_ROLE, planPrompt, supervisePrompt } from "./prompts"
import { actorSchema, parsePlanningResponse, parseSupervisionResponse, personaSchema, validateMission } from "./schemas"
import { applyRecovery } from "./supervision"
import { CTO_ROLE, TECHNICAL_DIRECTOR_ROLE } from "./technical-lead"
import type { Actor, Persona } from "./types"

describe("Director and Actor contract compatibility", () => {
  it("normalizes actorType and accepts legacy agentType without changing the native Actor shape", () => {
    const legacy: Persona = fixture().mission.personas[0] as Actor
    const canonical = actorData(legacy)
    expect(canonical).toHaveProperty("actorType", "codex")
    expect(canonical).not.toHaveProperty("agentType")
    expect(actorSchema.parse(canonical)).toEqual(legacy)
    expect(actorSchema.parse(legacy)).toEqual(legacy)
    expect(personaSchema).toBe(actorSchema)
    expect(actorSchema.parse({ ...legacy, actorType: "codex" })).toEqual(legacy)
  })

  it("rejects conflicting or missing CLI aliases instead of selecting an unintended vendor", () => {
    const legacy = fixture().mission.personas[0] as Actor
    expect(() => actorSchema.parse({ ...legacy, actorType: "claude" })).toThrow("conflicts")
    const { agentType: _type, ...missing } = legacy
    expect(() => actorSchema.parse(missing)).toThrow("Set actorType")
  })

  it("keeps canonical director role exports identical to the legacy constants", () => {
    expect(CTO_ROLE).toBe(TECHNICAL_DIRECTOR_ROLE)
    expect(CDO_ROLE).toBe(DESIGN_DIRECTOR_ROLE)
    expect(CMO_ROLE).toBe(MARKETING_DIRECTOR_ROLE)
    expect(CHIEF_DIRECTOR_ROLE).toContain("autonomous executive")
    expect(TECHNICAL_DIRECTOR_ROLE).toContain("total cost")
    expect(DESIGN_DIRECTOR_ROLE).toContain("enjoys and frequently uses dark patterns")
    expect(MARKETING_DIRECTOR_ROLE).toContain("maniacal profit fanatic")
  })

  it("requests canonical planning fields and normalizes the complete response before dispatch", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    mission.availableAgents = ["codex", "cursor", "claude"]
    const actors = mission.personas.map(actorData).map(({ model: _model, ...actor }) => actor)
    const response = { actors, ...actorPlanData(plan), goalBrief: brief }
    runAgent.mockImplementationOnce(async () => JSON.stringify(response))
    const prompt = planPrompt(mission)
    expect(prompt).toContain('"actors":[{"id":')
    expect(prompt).toContain('"actorType":"..."')
    expect(prompt).toContain('"actorId":"..."')
    expect(prompt).toContain('"availableActors":["codex","cursor","claude"]')
    expect(prompt).not.toContain('"personas":')
    expect(prompt).not.toContain('"agentType":')
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.plan).toEqual(plan)
    expect(mission.personas[0]?.model).toBe("operator-model")
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[0]).toMatchObject({
      id: "worker",
      agentType: "cursor",
    })
    const saved = validateMission(snapshots.at(-1) as typeof mission)
    expect(saved.plan?.tasks[0]?.personaId).toBe("worker")
    expect(saved.personas[0]?.agentType).toBe("codex")
    expect(saved).not.toHaveProperty("actors")
  })

  it("rejects conflicting roster and assignment aliases before mutating a saved mission", () => {
    const { mission } = fixture()
    mission.availableAgents = ["codex", "cursor", "claude"]
    const actors = mission.personas.map(actorData).map(({ model: _model, ...actor }) => actor)
    const response = { actors, ...actorPlanData(plan), goalBrief: brief }
    expect(() => parsePlanningResponse(JSON.stringify({ ...response, personas: actors }), mission)).toThrow(
      "not both rosters",
    )
    const task = response.tasks?.[0]
    expect(() =>
      parsePlanningResponse(JSON.stringify({ ...response, tasks: [{ ...task, personaId: "reviewer" }] }), mission),
    ).toThrow("actorId conflicts")
    expect(mission.plan).toBeUndefined()
  })

  it.each([
    [false, false, false, ["tasks"]],
    [true, false, false, ["tasks", "actors"]],
    [false, true, false, ["tasks", "goalBrief"]],
    [true, true, false, ["tasks", "actors", "goalBrief"]],
    [false, true, true, ["tasks", "goalBrief", "verificationContract"]],
    [true, true, true, ["tasks", "actors", "goalBrief", "verificationContract"]],
  ] as const)(
    "separates input identities from response keys for roster=%s supervision=%s chief verification=%s",
    (roster, supervised, chiefVerification, keys) => {
      const { mission } = fixture()
      if (roster) mission.availableAgents = ["codex", "cursor", "claude"]
      if (!supervised) delete mission.supervision
      if (chiefVerification) mission.verificationMode = "chief"
      mission.technicalLeadId = "technical-director"
      mission.designLeadId = "design-director"
      mission.marketingLeadId = "marketing-director"
      const prompt = planPrompt(mission)
      expect(prompt).toContain(`Allowed top-level response keys for this mode: ${JSON.stringify(keys)}.`)
      expect(prompt).toContain("Mission input identity fields are metadata, not response fields")
      expect(prompt).toContain(
        "Do not copy chiefId, technicalLeadId, designLeadId or marketingLeadId into the response root",
      )
      expect(prompt).toContain("retain nominated companions only as entries in actors")
      const input = JSON.parse(prompt.split("Mission input (JSON data):\n")[1] ?? "")
      expect(input.technicalLeadId).toBe(mission.technicalLeadId)
      expect(input.designLeadId).toBe(mission.designLeadId)
      expect(input.marketingLeadId).toBe(mission.marketingLeadId)
    },
  )

  it("still rejects the observed planning response with copied Director metadata", () => {
    const { mission } = fixture()
    const response = { ...actorPlanData(plan), goalBrief: brief }
    expect(parsePlanningResponse(JSON.stringify(response), mission).plan).toEqual(plan)
    const before = JSON.stringify(mission)
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({
          ...response,
          technicalLeadId: "technical-director",
          designLeadId: "design-director",
          marketingLeadId: "marketing-director",
        }),
        mission,
      ),
    ).toThrow(/Unrecognized keys/)
    expect(JSON.stringify(mission)).toBe(before)
  })

  it.each([false, true])("specifies the nested Task contract with generated roster=%s", (generated) => {
    const { mission } = fixture()
    if (generated) mission.availableAgents = ["codex", "cursor", "claude"]
    const prompt = planPrompt(mission)
    expect(prompt).toContain(
      'Allowed keys for each tasks[] object: ["id","title","actorId","instructions","acceptance","dependencies","effectScope"].',
    )
    expect(prompt).toContain("skills, model and role are Actor fields, never Task fields")
    expect(prompt).toContain("Use actorId for new responses; personaId is accepted only for legacy compatibility")
  })

  it.each([{ skills: [] }, { model: "codex" }, { role: "Worker" }])(
    "rejects Actor metadata on a Task without changing the Mission: %j",
    (metadata) => {
      const { mission } = fixture()
      const response = { ...actorPlanData(plan), goalBrief: brief }
      const before = JSON.stringify(mission)
      expect(() =>
        parsePlanningResponse(
          JSON.stringify({ ...response, tasks: [{ ...response.tasks?.[0], ...metadata }] }),
          mission,
        ),
      ).toThrow(/Unrecognized key/)
      expect(JSON.stringify(mission)).toBe(before)
      expect(parsePlanningResponse(JSON.stringify(response), mission).plan).toEqual(plan)
      expect(parsePlanningResponse(JSON.stringify({ ...plan, goalBrief: brief }), mission).plan).toEqual(plan)
    },
  )

  it("accepts canonical recovery assignments and preserves legacy task state IDs", () => {
    const { mission } = fixture()
    mission.plan = structuredClone(plan)
    const decision = parseSupervisionResponse(
      JSON.stringify({
        action: "reassign",
        reason: "Use another Actor with the required capability.",
        taskId: "onboarding",
        actorId: "reviewer",
        instructions: "Finish the original acceptance obligations.",
      }),
      mission,
    )
    expect(decision).toMatchObject({ personaId: "reviewer" })
    expect(decision).not.toHaveProperty("actorId")
    applyRecovery(mission, decision)
    expect(mission.plan.tasks[0]?.personaId).toBe("reviewer")
    expect(mission.tasks[0]?.reviewerId).not.toBe("reviewer")
    expect(supervisePrompt(mission)).toContain('"actorId":"different existing Actor"')
    expect(() => parseSupervisionResponse(JSON.stringify({ ...decision, actorId: "worker" }), mission)).toThrow(
      "conflicts",
    )
  })

  it("replaces legacy recovery instructions while keeping the original assignment and acceptance", () => {
    const { mission } = fixture()
    mission.plan = structuredClone(plan)
    const task = mission.plan.tasks[0]
    if (!task) throw new Error("Missing assignment fixture")
    const original = task.instructions
    task.instructions += "\n\nChief recovery:\nPrevious repair instructions."
    applyRecovery(mission, { action: "repair", reason: "Refresh the repair", instructions: "Current repair." })
    expect(task.instructions).toBe(`${original}\n\nChief Director recovery:\nCurrent repair.`)
    expect(task.acceptance).toEqual(plan.tasks[0]?.acceptance)
  })
})
