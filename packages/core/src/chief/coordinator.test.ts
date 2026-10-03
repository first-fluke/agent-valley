import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { parsePlan, parseReview, validateMission } from "./schemas"
import type { ChiefPlan, ChiefPorts, Mission, Persona } from "./types"

const personas: Persona[] = [
  { id: "chief", name: "Chief Director", role: "Coordinate and verify", agentType: "codex", skills: [] },
  { id: "engineer", name: "Engineer", role: "Implement the task", agentType: "codex", skills: ["oma-backend"] },
]
const plan: ChiefPlan = {
  tasks: [
    {
      id: "implement",
      title: "Implement feature",
      personaId: "engineer",
      instructions: "Implement and test the feature",
      acceptance: ["Feature works and has test evidence"],
      dependencies: [],
    },
  ],
}
const passed = JSON.stringify({ passed: true, summary: "Inspected the change and acceptance evidence.", findings: [] })
const rejected = JSON.stringify({
  passed: false,
  summary: "The failure path is missing.",
  findings: ["Handle missing input."],
})

function fixture() {
  const mission: Mission = {
    id: "mission-1",
    goal: "Implement feature",
    chiefId: "chief",
    personas: structuredClone(personas),
    workspace: {
      issueId: "mission-1",
      path: "/workspace/mission-1",
      key: "mission-1",
      branch: "chief/mission-1",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "bun run test",
    timeoutSec: 300,
    maxRepairs: 2,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
  let fingerprint = "initial"
  let work = 0
  const snapshots: Mission[] = []
  const runAgent = vi.fn<ChiefPorts["runAgent"]>(async (_persona, _prompt, _mission, stage) => {
    if (stage === "plan") return JSON.stringify(plan)
    if (stage === "work") {
      fingerprint = `change-${++work}`
      return "Updated feature.ts and verified missing input behavior."
    }
    return passed
  })
  const verify = vi.fn<ChiefPorts["verify"]>(async () => ({ ok: true, output: "Tests passed" }))
  const ports: ChiefPorts = {
    runAgent,
    verify,
    save: async (value) => {
      snapshots.push(structuredClone(value))
    },
    fingerprint: async () => fingerprint,
  }
  return {
    mission,
    ports,
    snapshots,
    runAgent,
    verify,
    mutate: (value: string) => {
      fingerprint = value
    },
  }
}

describe("chief coordinator", () => {
  it("persists every stage and requires independent review, trusted verification, and final approval", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(runAgent.mock.calls.map((call) => [call[0].id, call[3]])).toEqual([
      ["chief", "plan"],
      ["engineer", "work"],
      ["chief", "review"],
      ["chief", "final-review"],
    ])
    expect(verify).toHaveBeenCalledOnce()
    expect(mission.initialFingerprint).toBe("initial")
    expect(mission.verification).toEqual({ ok: true, output: "Tests passed", fingerprint: "change-1" })
    expect(snapshots.some((saved) => saved.tasks[0]?.status === "running" && !saved.tasks[0]?.output)).toBe(true)
    expect(snapshots.some((saved) => saved.tasks[0]?.output && saved.tasks[0]?.status === "running")).toBe(true)
    expect(snapshots.some((saved) => saved.status === "verifying" && !saved.verification)).toBe(true)
    expect(snapshots.at(-1)?.status).toBe("completed")
  })

  it("runs dependencies first even when the plan lists tasks in reverse order", async () => {
    const { mission, ports, runAgent } = fixture()
    runAgent.mockImplementationOnce(async () =>
      JSON.stringify({
        tasks: [
          { ...plan.tasks[0], id: "second", dependencies: ["first"] },
          { ...plan.tasks[0], id: "first" },
        ],
      }),
    )
    await coordinate(mission, ports)
    expect(mission.history.filter((event) => event.stage === "task-completed").map((event) => event.taskId)).toEqual([
      "first",
      "second",
    ])
  })

  it("assigns another reviewer when the chief performs a task", async () => {
    const { mission, ports, runAgent } = fixture()
    runAgent.mockImplementationOnce(async () => JSON.stringify({ tasks: [{ ...plan.tasks[0], personaId: "chief" }] }))
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.find((call) => call[3] === "review")?.[0].id).toBe("engineer")
  })

  it("repairs rejected task evidence before accepting the task", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review" && reviews++ === 0 ? rejected : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(mission.tasks[0]?.repairRound).toBe(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")[1]?.[1]).toContain("Handle missing input.")
  })

  it("stops when a task exhausts its repair budget", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.maxRepairs = 1
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review" ? rejected : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("failed review after 1 repairs")
    expect(mission.status).toBe("failed")
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(verify).not.toHaveBeenCalled()
  })

  it("routes final rejection back to Actors and repeats verification", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) =>
      args[3] === "final-review" && reviews++ === 0 ? rejected : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission.repairRound).toBe(1)
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")[1]?.[1]).toContain("Handle missing input.")
  })

  it("repairs deterministic verification failures even when every model review passes", async () => {
    const { mission, ports, verify, runAgent } = fixture()
    verify.mockResolvedValueOnce({ ok: false, output: "FAIL feature.test.ts: missing input" })
    await coordinate(mission, ports)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")[1]?.[1]).toContain("FAIL feature.test.ts")
    expect(runAgent.mock.calls.filter((call) => call[3] === "final-review")).toHaveLength(1)
  })

  it("fails when trusted verification exhausts its budget", async () => {
    const { mission, ports, verify } = fixture()
    mission.maxRepairs = 0
    verify.mockResolvedValue({ ok: false })
    await expect(coordinate(mission, ports)).rejects.toThrow("verification command failed")
    expect(mission.status).toBe("failed")
  })

  it("requires a material deliverable even when verification and model reports pass", async () => {
    const { mission, ports, runAgent } = fixture()
    mission.maxRepairs = 0
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "work" ? "Done, see my stdout." : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("No material deliverable changed")
    expect(mission.verification?.ok).toBe(false)
    expect(mission.status).toBe("failed")
  })

  it.each(["plan", "review", "final-review"] as const)("rejects writes made during %s", async (stage) => {
    const { mission, ports, runAgent, mutate } = fixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      const output = (await original?.(...args)) ?? ""
      if (args[3] === stage) mutate("unauthorized-change")
      return output
    })
    await expect(coordinate(mission, ports)).rejects.toThrow(`${stage} Actor changed the worktree`)
    expect(mission.status).toBe("failed")
  })

  it("resumes interrupted work without trusting a partial edit or losing the initial baseline", async () => {
    const { mission, ports, runAgent, mutate } = fixture()
    mission.maxRepairs = 0
    const original = runAgent.getMockImplementation()
    let failed = false
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work" && !failed) {
        failed = true
        mutate("partial-work")
        throw new Error("Runner disconnected")
      }
      return (await original?.(...args)) ?? ""
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("Runner disconnected")
    const restored = structuredClone(mission)
    await coordinate(restored, ports)
    expect(restored.status).toBe("completed")
    expect(restored.tasks[0]?.attempts).toBe(2)
    expect(restored.initialFingerprint).toBe("initial")
    expect(restored.error).toBeUndefined()
    expect(runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(1)
  })

  it("invalidates saved approvals when the worktree changes between runs", async () => {
    const { mission, ports, mutate, verify } = fixture()
    await coordinate(mission, ports)
    mutate("external-edit")
    await coordinate(mission, ports)
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(mission.history.some((event) => event.message.includes("all task reviews will run again"))).toBe(true)
  })

  it("reruns deterministic verification on a completed mission without rerunning unchanged tasks", async () => {
    const { mission, ports, verify } = fixture()
    await coordinate(mission, ports)
    await coordinate(mission, ports)
    expect(mission.tasks[0]?.attempts).toBe(1)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it("persists an interrupted state before any Actor runs", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    ports.signal = AbortSignal.abort()
    await expect(coordinate(mission, ports)).rejects.toThrow("Mission interrupted")
    expect(runAgent).not.toHaveBeenCalled()
    expect(snapshots.at(-1)?.status).toBe("failed")
  })

  it("does not approve a mission if the verifier crashes", async () => {
    const { mission, ports, verify } = fixture()
    verify.mockRejectedValueOnce(new Error("Verifier exited unexpectedly"))
    await expect(coordinate(mission, ports)).rejects.toThrow("Verifier exited unexpectedly")
    expect(mission.status).toBe("failed")
  })
})

describe("chief boundaries", () => {
  it("accepts a single fenced JSON response", () => {
    expect(parsePlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, personas)).toEqual(plan)
  })

  it.each([
    ["cycle", { tasks: [{ ...plan.tasks[0], dependencies: ["implement"] }] }],
    ["Unknown Actor", { tasks: [{ ...plan.tasks[0], personaId: "missing" }] }],
    ["Duplicate task", { tasks: [plan.tasks[0], plan.tasks[0]] }],
    ["unknown task", { tasks: [{ ...plan.tasks[0], dependencies: ["missing"] }] }],
    [
      "repeats a dependency",
      {
        tasks: [
          { ...plan.tasks[0], id: "first" },
          { ...plan.tasks[0], dependencies: ["first", "first"] },
        ],
      },
    ],
  ])("rejects invalid plans: %s", (message, invalid) => {
    expect(() => parsePlan(JSON.stringify(invalid), personas)).toThrow(String(message))
  })

  it("rejects empty acceptance, unexpected commands, and oversized plans", () => {
    expect(() => parsePlan(JSON.stringify({ tasks: [{ ...plan.tasks[0], acceptance: [] }] }), personas)).toThrow()
    expect(() => parsePlan(JSON.stringify({ ...plan, verifyCommand: "true" }), personas)).toThrow()
    expect(() => parsePlan(JSON.stringify({ tasks: Array(13).fill(plan.tasks[0]) }), personas)).toThrow()
  })

  it("rejects contradictory, missing, malformed, and oversized review evidence", () => {
    expect(() => parseReview('{"passed":true,"summary":"ok","findings":["broken"]}')).toThrow()
    expect(() => parseReview('{"passed":false,"summary":"bad","findings":[]}')).toThrow()
    expect(() => parseReview("Actor said done")).toThrow("not valid JSON")
    expect(() => parseReview("x".repeat(128_001))).toThrow("exceeds 128 KB")
  })

  it("validates persisted Actor and task state before resuming", async () => {
    const { mission, ports } = fixture()
    await coordinate(mission, ports)
    const invalid = structuredClone(mission)
    const task = invalid.tasks[0]
    if (!task) throw new Error("Expected task state")
    task.reviewerId = "engineer"
    expect(() => validateMission(invalid)).toThrow("reviewer different from its Actor")
    task.reviewerId = "chief"
    delete task.review
    expect(() => validateMission(invalid)).toThrow("lacks passing review evidence")
    invalid.tasks = []
    expect(() => validateMission(invalid)).toThrow("does not match the plan")
    delete invalid.plan
    invalid.personas.push(personas[0] as Persona)
    expect(() => validateMission(invalid)).toThrow("Duplicate Actor ids")
  })
})
