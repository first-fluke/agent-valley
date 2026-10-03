import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { planPrompt } from "./prompts"
import { parsePlanningResponse, validateMission } from "./schemas"
import type { ChiefPlan, ChiefPorts, ChiefTask, Mission, Persona } from "./types"

const passed = JSON.stringify({
  passed: true,
  summary: "Inspected the deliverable and acceptance evidence.",
  findings: [],
})

function fixture(goal = "Implement a login API") {
  const mission: Mission = {
    id: "automatic-mission",
    goal,
    chiefId: "chief",
    personas: [
      { id: "chief", name: "Chief Director", role: "Plan the goal", agentType: "codex", skills: [] },
      { id: "reviewer", name: "Reviewer", role: "Review the goal", agentType: "codex", skills: [] },
    ],
    availableAgents: ["codex", "cursor", "claude"],
    workspace: {
      issueId: "automatic-mission",
      path: "/workspace/automatic-mission",
      key: "automatic-mission",
      branch: "chief/automatic-mission",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "bun test",
    timeoutSec: 300,
    maxRepairs: 1,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
  let fingerprint = "initial"
  const snapshots: Mission[] = []
  const runAgent = vi.fn<ChiefPorts["runAgent"]>(async (_persona, _prompt, _mission, stage) => {
    if (stage === "plan") return JSON.stringify(planning())
    if (stage === "work") {
      fingerprint = "deliverable-changed"
      return "Updated the requested deliverable and checked its acceptance criteria."
    }
    return passed
  })
  const ports: ChiefPorts = {
    runAgent,
    verify: vi.fn(async () => ({ ok: true, output: "Tests passed" })),
    fingerprint: async () => fingerprint,
    save: async (value) => {
      snapshots.push(JSON.parse(JSON.stringify(value)))
    },
  }
  return { mission, ports, runAgent, snapshots }
}

function planning(workerId = "api-engineer", role = "Implement authentication APIs and their regression tests") {
  const personas: Persona[] = [
    { id: "chief", name: "Delivery Chief Director", role: "Plan and verify this goal", agentType: "codex", skills: [] },
    { id: workerId, name: workerId, role, agentType: "cursor", skills: [] },
    {
      id: "reviewer",
      name: "Acceptance Reviewer",
      role: "Inspect task evidence independently",
      agentType: "claude",
      skills: [],
    },
  ]
  const plan: ChiefPlan = {
    tasks: [
      {
        id: "deliver",
        title: "Deliver the requested change",
        personaId: workerId,
        instructions: "Produce the requested file deliverable and verify its acceptance criteria",
        acceptance: ["Requested deliverable exists and has verification evidence"],
        dependencies: [],
      },
    ],
  }
  return { personas, ...plan }
}

describe("automatic Actor planning", () => {
  it.each([
    ["Implement a login API", "api-engineer", "Implement authentication APIs and their regression tests"],
    [
      "Write a migration analysis report",
      "migration-analyst",
      "Analyze migration constraints and write a sourced report",
    ],
  ])("creates a goal-specific roster and selects supplied CLIs for %s", async (goal, workerId, role) => {
    const { mission, ports, runAgent, snapshots } = fixture(goal)
    const response = planning(workerId, role)
    runAgent.mockImplementationOnce(async () => JSON.stringify(response))

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(mission.personas).toEqual(response.personas)
    expect(runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(1)
    expect(runAgent.mock.calls[0]?.[1]).toContain(goal)
    expect(runAgent.mock.calls[0]?.[1]).toContain("Create 2-8 Actors")
    expect(runAgent.mock.calls[0]?.[1]).toContain('"availableActors":["codex","cursor","claude"]')
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[0]).toMatchObject({
      id: workerId,
      agentType: "cursor",
      role,
    })
    expect(runAgent.mock.calls.find((call) => call[3] === "review")?.[0]).toMatchObject({
      id: "reviewer",
      agentType: "claude",
    })
    expect(mission.tasks[0]?.reviewerId).not.toBe(workerId)
    const checkpoint = snapshots.find((snapshot) => snapshot.plan)
    expect(checkpoint?.personas).toEqual(response.personas)
    expect(checkpoint?.plan?.tasks).toEqual(response.tasks)
    expect(checkpoint?.tasks).toHaveLength(1)
  })

  it("accepts two independent Actors using the only available CLI", async () => {
    const { mission, ports, runAgent } = fixture()
    mission.availableAgents = ["codex"]
    const response = planning("chief")
    response.personas = response.personas.filter(
      (persona) => persona.id !== "chief" || persona.name === "Delivery Chief Director",
    )
    response.personas.forEach((persona) => {
      persona.agentType = "codex"
    })
    runAgent.mockImplementationOnce(async () => JSON.stringify(response))

    await coordinate(mission, ports)

    expect(mission.tasks[0]?.reviewerId).toBe("reviewer")
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[0].id).toBe("chief")
    expect(runAgent.mock.calls.find((call) => call[3] === "review")?.[0].id).toBe("reviewer")
  })

  it("retains the operator's custom Chief Director vendor and model across planning and saved validation", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    mission.chiefId = "director"
    const selectedChief = mission.personas[0] as Persona
    selectedChief.id = "director"
    selectedChief.agentType = "claude"
    selectedChief.model = "operator-selected-model"
    const response = planning()
    const generatedChief = response.personas[0] as Persona
    generatedChief.id = "director"
    generatedChief.agentType = "claude"
    runAgent.mockImplementationOnce(async () => JSON.stringify(response))

    await coordinate(mission, ports)

    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      id: "director",
      agentType: "claude",
      model: "operator-selected-model",
    })
    expect(runAgent.mock.calls[0]?.[1]).toContain('Chief Director CLI is fixed: {"id":"director","actorType":"claude"}')
    expect(mission.personas.find((persona) => persona.id === "director")).toMatchObject({
      agentType: "claude",
      model: "operator-selected-model",
    })
    expect(runAgent.mock.calls.find((call) => call[3] === "final-review")?.[0]).toMatchObject({
      id: "director",
      agentType: "claude",
      model: "operator-selected-model",
    })
    expect(
      mission.personas.filter((persona) => persona.id !== "director").every((persona) => persona.model === undefined),
    ).toBe(true)
    const saved = validateMission(snapshots.at(-1) as Mission)
    expect(saved.personas.find((persona) => persona.id === "director")?.model).toBe("operator-selected-model")
    expect(response.personas.every((persona) => persona.model === undefined)).toBe(true)
  })

  it("resumes the persisted generated roster and plan without replanning", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    const chief = mission.personas[0] as Persona
    chief.model = "retained-chief-model"
    runAgent.mockImplementationOnce(async () => JSON.stringify(planning()))
    runAgent.mockImplementationOnce(async () => {
      throw new Error("Worker interrupted before changing files")
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("Worker interrupted")
    const saved = snapshots.at(-1) as Mission
    expect(saved.plan).toBeDefined()
    expect(saved.personas.find((persona) => persona.id === "api-engineer")?.agentType).toBe("cursor")
    const resumed = validateMission(JSON.parse(JSON.stringify(saved)))
    runAgent.mockClear()

    await coordinate(resumed, ports)

    expect(resumed.status).toBe("completed")
    expect(resumed.personas).toEqual(saved.personas)
    expect(resumed.personas.find((persona) => persona.id === "chief")?.model).toBe("retained-chief-model")
    expect(runAgent.mock.calls.some((call) => call[3] === "plan")).toBe(false)
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ id: "api-engineer", agentType: "cursor" })
  })

  it("rejects a task-only response instead of silently retaining bootstrap Actors", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = structuredClone(mission.personas)
    const { tasks } = planning()
    runAgent.mockImplementationOnce(async () => JSON.stringify({ tasks }))

    await expect(coordinate(mission, ports)).rejects.toThrow()

    expect(mission.personas).toEqual(original)
    expect(mission.plan).toBeUndefined()
    expect(mission.tasks).toEqual([])
    expect(runAgent.mock.calls.some((call) => call[3] === "work")).toBe(false)
  })

  it.each([
    [
      "unavailable CLI",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[1] as Persona).agentType = "kimi"
      },
      /Unavailable Actor type kimi/,
    ],
    [
      "duplicate Actor",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[1] as Persona).id = "chief"
      },
      /Duplicate Actor ids/,
    ],
    [
      "missing chief",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[0] as Persona).id = "another-chief"
      },
      /omit chiefId chief/,
    ],
    [
      "unknown Actor",
      (response: ReturnType<typeof planning>) => {
        ;(response.tasks[0] as ChiefTask).personaId = "missing"
      },
      /Unknown Actor missing/,
    ],
    [
      "dependency cycle",
      (response: ReturnType<typeof planning>) => {
        ;(response.tasks[0] as ChiefTask).dependencies = ["deliver"]
      },
      /dependency cycle/,
    ],
    [
      "invented model",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[1] as Persona).model = "fictional-model"
      },
      /cannot set model identifiers/,
    ],
    [
      "generated Chief Director model",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[0] as Persona).model = "invented-chief-model"
      },
      /cannot set model identifiers/,
    ],
    [
      "replaced Chief Director vendor",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[0] as Persona).agentType = "claude"
      },
      /must keep the selected actorType codex/,
    ],
    [
      "unverified skill",
      (response: ReturnType<typeof planning>) => {
        ;(response.personas[1] as Persona).skills = ["oma-backend"]
      },
      /cannot attach unverified skills/,
    ],
  ])("rejects %s before replacing mission state", (_name, mutate, message) => {
    const { mission } = fixture()
    const original = structuredClone(mission)
    const response = planning()
    mutate(response)

    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow(message)
    expect(mission).toEqual(original)
  })

  it("rejects empty acceptance and more than eight generated Actors", () => {
    const { mission } = fixture()
    const response = planning()
    const task = response.tasks[0] as ChiefTask
    task.acceptance = []
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow()
    task.acceptance = ["Deliverable verified"]
    while (response.personas.length < 9) {
      response.personas.push({
        id: `specialist-${response.personas.length}`,
        name: "Specialist",
        role: "Inspect evidence",
        agentType: "codex",
        skills: [],
      })
    }
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow()
  })

  it("rejects oversized automatic plans before transport truncation can lose the roster", () => {
    const { mission } = fixture()
    const response = planning()
    const task = response.tasks[0] as ChiefTask
    task.instructions = "x".repeat(8_000)
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow(/exceeds 8,000 characters/)
  })

  it("validates available CLI capabilities and saved automatic rosters", () => {
    const { mission } = fixture()
    mission.availableAgents = []
    expect(() => validateMission(mission)).toThrow()
    mission.availableAgents = ["codex", "codex"]
    expect(() => validateMission(mission)).toThrow(/Duplicate available Actor types/)
    mission.availableAgents = ["claude"]
    expect(() => validateMission(mission)).toThrow(/Unavailable Actor type codex/)
    mission.availableAgents = ["codex"]
    const worker = mission.personas[1] as Persona
    worker.model = "invented-worker-model"
    expect(() => validateMission(mission)).toThrow(/cannot set model identifiers/)
  })

  it("preserves supplied Actor models and skills with a tasks-only plan", async () => {
    const { mission, ports, runAgent } = fixture()
    delete mission.availableAgents
    const reviewer = mission.personas[1] as Persona
    reviewer.model = "operator-selected-model"
    reviewer.skills = ["operator-skill"]
    const configured = structuredClone(mission.personas)
    const { tasks } = planning("reviewer")
    runAgent.mockImplementationOnce(async () => JSON.stringify({ tasks }))

    expect(planPrompt(mission)).toContain("Use only configured Actor ids")
    expect(planPrompt(mission)).not.toContain("Create 2-8 Actors")
    await coordinate(mission, ports)

    expect(mission.personas).toEqual(configured)
    expect(mission.tasks[0]?.reviewerId).toBe("chief")
  })
})
