import { describe, expect, it } from "vitest"
import { selectRepairTaskId, selectVerificationRepairScope, selectVerificationRepairTaskId } from "./coordinator-state"
import { fixture, plan } from "./goal-supervision.fixture"
import {
  BUILD_AUTHORIZATION_RULE,
  HANDOFF_PATH_RULE,
  OWN_REPAIR_RULE,
  planPrompt,
  reviewPrompt,
  workPrompt,
} from "./prompts"
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

  it("routes file-only verification failure to task whose changeSet delivered the failing file", () => {
    const mission = missionWithGates()
    mission.tasks = [
      {
        id: "implement",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        changeSet: {
          version: 1,
          inputTree: "0".repeat(40),
          deliveryTree: "1".repeat(40),
          files: [{ path: "src/app.ts", status: "added", size: 100, sha256: "a".repeat(64) }],
          diff: "",
          diffTruncated: false,
        },
      },
      {
        id: "gates",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        changeSet: {
          version: 1,
          inputTree: "1".repeat(40),
          deliveryTree: "2".repeat(40),
          files: [{ path: ".arc-verify/qa.md", status: "added", size: 50, sha256: "b".repeat(64) }],
          diff: "",
          diffTruncated: false,
        },
      },
    ]
    mission.goalVerification = {
      ok: false,
      output: "FAIL: .arc-verify/qa.md missing string TRF-019",
      contractSha256: "c".repeat(64),
      checkedAt: new Date().toISOString(),
      evidence: [
        {
          criterion: "Tests pass",
          passed: true,
          checks: [
            {
              checkSha256: "1".repeat(64),
              kind: "command",
              passed: true,
              exitCode: 0,
              summary: "cargo test passed",
              outputSha256: "d".repeat(64),
            },
          ],
        },
        {
          criterion: "QA report present",
          passed: false,
          checks: [
            {
              checkSha256: "2".repeat(64),
              kind: "file",
              passed: false,
              summary: "FAIL: missing TRF-019",
              path: ".arc-verify/qa.md",
            },
          ],
        },
      ],
    }

    const scope = selectVerificationRepairScope(mission)
    expect(scope).toEqual(new Set(["gates"]))
    expect(selectVerificationRepairTaskId(mission)).toBe("gates")
    // selectRepairTaskId also returns "gates" even though planner lacks CODE_SKILL
    expect(selectRepairTaskId(mission)).toBe("gates")
  })

  it("includes transitive dependents in verification repair scope", () => {
    const mission = missionWithGates()
    const taskImplement = mission.plan?.tasks[1]
    const taskGates = mission.plan?.tasks[2]
    if (!taskImplement || !taskGates) throw new Error("Expected tasks")
    // Make taskGates depend on taskImplement
    taskGates.dependencies = [taskImplement.id]
    mission.tasks = [
      {
        id: "implement",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        changeSet: {
          version: 1,
          inputTree: "0".repeat(40),
          deliveryTree: "1".repeat(40),
          files: [{ path: "src/app.ts", status: "modified", size: 100, sha256: "a".repeat(64) }],
          diff: "",
          diffTruncated: false,
        },
      },
      {
        id: "gates",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        changeSet: {
          version: 1,
          inputTree: "1".repeat(40),
          deliveryTree: "2".repeat(40),
          files: [{ path: ".arc-verify/qa.md", status: "added", size: 50, sha256: "b".repeat(64) }],
          diff: "",
          diffTruncated: false,
        },
      },
    ]
    // Verification fails on src/app.ts (delivered by taskImplement)
    mission.goalVerification = {
      ok: false,
      output: "FAIL: src/app.ts check",
      contractSha256: "c".repeat(64),
      checkedAt: new Date().toISOString(),
      evidence: [
        {
          criterion: "App check",
          passed: false,
          checks: [
            {
              checkSha256: "3".repeat(64),
              kind: "file",
              passed: false,
              summary: "FAIL",
              path: "src/app.ts",
            },
          ],
        },
      ],
    }

    const scope = selectVerificationRepairScope(mission)
    // Both implement and dependent gates must be in scope
    expect(scope).toEqual(new Set(["implement", "gates"]))
  })

  it("falls back to unique path match in task text when changeSet has no match", () => {
    const mission = missionWithGates()
    mission.tasks = [] // No changeSets
    const gatesTask = mission.plan?.tasks[2]
    if (!gatesTask) throw new Error("Expected gates task")
    gatesTask.instructions = "Write results to .arc-verify/report.json"
    mission.goalVerification = {
      ok: false,
      output: "FAIL: report.json",
      contractSha256: "c".repeat(64),
      checkedAt: new Date().toISOString(),
      evidence: [
        {
          criterion: "Report check",
          passed: false,
          checks: [
            {
              checkSha256: "4".repeat(64),
              kind: "json",
              passed: false,
              summary: "FAIL",
              path: ".arc-verify/report.json",
            },
          ],
        },
      ],
    }

    expect(selectVerificationRepairScope(mission)).toEqual(new Set(["gates"]))
  })

  it("falls back to code-capable task if any command check fails", () => {
    const mission = missionWithGates()
    mission.tasks = [
      {
        id: "gates",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        changeSet: {
          version: 1,
          inputTree: "1".repeat(40),
          deliveryTree: "2".repeat(40),
          files: [{ path: ".arc-verify/qa.md", status: "added", size: 50, sha256: "b".repeat(64) }],
          diff: "",
          diffTruncated: false,
        },
      },
    ]
    mission.goalVerification = {
      ok: false,
      output: "FAIL: command + file",
      contractSha256: "c".repeat(64),
      checkedAt: new Date().toISOString(),
      evidence: [
        {
          criterion: "Command and file",
          passed: false,
          checks: [
            {
              checkSha256: "5".repeat(64),
              kind: "command",
              passed: false,
              exitCode: 1,
              summary: "cargo test failed",
              outputSha256: "d".repeat(64),
            },
            {
              checkSha256: "6".repeat(64),
              kind: "file",
              passed: false,
              summary: "FAIL",
              path: ".arc-verify/qa.md",
            },
          ],
        },
      ],
    }

    expect(selectVerificationRepairScope(mission)).toBeNull()
    expect(selectVerificationRepairTaskId(mission)).toBeUndefined()
    // selectRepairTaskId falls back to codeCapable (implement)
    expect(selectRepairTaskId(mission)).toBe("implement")
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

  it("tells Actors to repair failing checks themselves instead of handing them to another owner", () => {
    const mission = missionWithGates()
    const task = mission.plan?.tasks[1]
    const persona = mission.personas.find((entry) => entry.id === "backend")
    if (!task || !persona) throw new Error("Expected fixture task and persona")
    const state: ChiefTaskState = { id: task.id, reviewerId: "reviewer", status: "running", attempts: 1 }
    expect(OWN_REPAIR_RULE).toContain("is not a repair")
    expect(workPrompt(mission, task, state, persona)).toContain(OWN_REPAIR_RULE)
    state.integrationCheck = { at: "2026-01-01T00:00:00.000Z", ok: false, output: "cargo test\nFAIL" }
    expect(reviewPrompt(mission, task, state)).toContain("do not direct it to another owner")
  })
})
