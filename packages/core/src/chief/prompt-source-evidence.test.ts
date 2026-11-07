import { describe, expect, it } from "vitest"
import { fixture, plan } from "./goal-supervision.fixture"
import { reviewPrompt, workPrompt } from "./prompts"
import type { ChiefTaskState } from "./types"

function sourceFixture() {
  const { mission } = fixture()
  const task = structuredClone(plan.tasks[0])
  if (!task) throw new Error("Expected a task")
  mission.plan = { tasks: [task] }
  const record = {
    version: 1 as const,
    missionId: mission.id,
    taskId: task.id,
    attempt: 1,
    sourceWorkspacePath: mission.workspace.path,
    path: "/workspace/isolated-actor",
    branch: "av-task/goal-mission/onboarding/1",
    baselineHead: "a".repeat(40),
    baselineTree: "b".repeat(40),
    snapshotCommit: "c".repeat(40),
    snapshotRef: "refs/agent-valley/task-evidence/goal-mission/onboarding/1/snapshot",
    workerRef: "refs/agent-valley/task-evidence/goal-mission/onboarding/1/worker",
  }
  const state: ChiefTaskState = {
    id: task.id,
    reviewerId: "reviewer",
    status: "reviewing",
    attempts: 1,
    output: `Inspected snapshot ${record.snapshotCommit}; delivered docs/onboarding.md.`,
    parallel: record,
  }
  mission.tasks = [state]
  const actor = mission.personas.find((entry) => entry.id === task.personaId)
  if (!actor) throw new Error("Expected a worker")
  return { mission, task, state, actor, record }
}

describe("parallel source provenance in Actor and review prompts", () => {
  it("binds the Actor assignment to its actual snapshot and distinguishes the committed baseline", () => {
    const { mission, task, state, actor, record } = sourceFixture()
    const local = { ...mission, workspace: { ...mission.workspace, path: record.path, branch: record.branch } }
    const prompt = workPrompt(local, task, state, actor)
    const input = JSON.parse(prompt.split("Assignment (JSON data):\n")[1] ?? "")
    expect(input.sourceEvidence).toEqual(record)
    expect(input.actorWorkspace).toEqual({ path: record.path, branch: record.branch })
    expect(input.mission.workspace).toBe(record.path)
    expect(prompt).toContain("accepted committed source baseline")
    expect(prompt).toContain("Label observations of the Actor's local HEAD")
    expect(prompt).toContain("does not imply that it is already tracked in the review checkout")
  })

  it("passes original source revisions to task and gate reviews without equating their HEADs", () => {
    const { mission, task, state, record } = sourceFixture()
    const prompt = reviewPrompt(mission, task, state)
    const input = JSON.parse(prompt.split("Review input (JSON data):\n")[1] ?? "")
    expect(input.sourceEvidence).toEqual(record)
    expect(input.reviewWorkspace.path).toBe(mission.workspace.path)
    expect(input.reviewWorkspace.path).not.toBe(record.path)
    expect(input.evidence.output).toContain(record.snapshotCommit)
    expect(prompt).toContain("A different current HEAD alone is not source fabrication")
    expect(prompt).toContain("workerRef preserves the Actor's checked-out HEAD at collection")
    expect(prompt).toContain("uncommitted task edits may be absent from that commit")
    expect(prompt).toContain("must be verified in the integrated worktree, using the delivery receipt when available")
    expect(prompt).toContain("Missing source objects, invalid revisions or inconsistent ancestry remain provenance failures")
    expect(prompt).toContain("Do not replace hashes in deliverables or approve unverified claims")
  })

  it("retains task mapping and source refs in final mission review", () => {
    const { mission, record } = sourceFixture()
    const input = JSON.parse(reviewPrompt(mission).split("Review input (JSON data):\n")[1] ?? "")
    expect(input.sourceEvidence).toEqual([record])
    expect(input.sourceEvidence[0].taskId).toBe(mission.tasks[0]?.id)
    expect(input.sourceEvidence[0].workerRef).toBe(record.workerRef)
  })

  it("does not invent snapshot commits or refs for a legacy workspace record", () => {
    const { mission, task, state, record } = sourceFixture()
    const { snapshotCommit: _snapshot, snapshotRef: _snapshotRef, workerRef: _workerRef, ...legacy } = record
    state.parallel = legacy
    const prompt = reviewPrompt(mission, task, state)
    const input = JSON.parse(prompt.split("Review input (JSON data):\n")[1] ?? "")
    expect(input.sourceEvidence).toEqual(legacy)
    expect(input.sourceEvidence.snapshotCommit).toBeUndefined()
    expect(prompt).toContain("never substitute another checkout's HEAD or invent a missing revision")
  })

  it("keeps the existing final review input when no task has parallel source evidence", () => {
    const { mission, state } = sourceFixture()
    delete state.parallel
    const prompt = reviewPrompt(mission)
    const input = JSON.parse(prompt.split("Review input (JSON data):\n")[1] ?? "")
    expect(input).not.toHaveProperty("sourceEvidence")
    expect(input).not.toHaveProperty("reviewWorkspace")
    expect(input.evidence).toEqual(mission.tasks)
    expect(prompt).not.toContain("Parallel source provenance:")
  })
})
