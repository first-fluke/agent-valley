import { vi } from "vitest"
import { type ContinuousBaseline, type Operation, operationSchema } from "./continuous-contract"
import type { ContinuousOperationPorts } from "./continuous-operation"
import type { Mission } from "./types"

export const timestamp = "2026-10-05T00:00:00.000Z"
export function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "operation",
    repositoryRoot: "/repo",
    charter: "Keep improving usability and revenue",
    settings: { actor: "codex", model: "pinned-model" },
    phase: "deciding",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedCycles: 0,
    waitIntervalSec: 300,
    history: [],
    ...overrides,
  }
}
export function baseline(missionId?: string): ContinuousBaseline {
  return {
    version: 1,
    operationId: "operation",
    repositoryRoot: "/repo",
    sourceWorkspacePath: missionId ? `/child/${missionId}` : "/repo",
    missionId,
    path: `/baseline/${missionId ?? "initial"}`,
    branch: "snapshot",
    baselineHead: "a".repeat(40),
    baselineTree: "b".repeat(40),
    commit: "c".repeat(40),
  }
}
export function mission(id: string, goal: string, status: Mission["status"] = "completed"): Mission {
  return {
    id,
    repositoryRoot: "/repo",
    goal,
    chiefId: "chief",
    personas: [
      { id: "chief", name: "Chief Director", role: "Executive judgment", agentType: "codex", skills: [] },
      { id: "worker", name: "Actor", role: "Implement improvement", agentType: "codex", skills: [] },
      { id: "reviewer", name: "Reviewer", role: "Independent review", agentType: "codex", skills: [] },
    ],
    workspace: { issueId: id, key: id, path: `/child/${id}`, branch: id, status: "idle", createdAt: timestamp },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status,
    goalBrief: { interpretation: goal, assumptions: [], successCriteria: ["Verified improvement"] },
    plan: {
      tasks: [
        {
          id: "work",
          title: "Improve",
          personaId: "worker",
          instructions: goal,
          acceptance: ["Verified improvement"],
          dependencies: [],
        },
      ],
    },
    fingerprint: "verified",
    verification: { ok: true, fingerprint: "verified" },
    finalReview: {
      passed: true,
      summary: "Verified",
      findings: [],
      criteria: [{ criterion: "Verified improvement", passed: true, evidence: "Actual product checks passed" }],
    },
    tasks: [
      {
        id: "work",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "approved-task",
        review: { passed: true, summary: "Actual product inspected", findings: [] },
      },
    ],
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
export function fixture(record = operation()) {
  let clock = Date.parse(timestamp)
  const saved: Operation[] = []
  const children = new Map<string, Mission>()
  const ports: ContinuousOperationPorts = {
    save: vi.fn(async (value) => {
      saved.push(operationSchema.parse(value))
    }),
    now: () => new Date(clock),
    delay: vi.fn(async (milliseconds) => {
      clock += milliseconds
    }),
    accept: vi.fn(async (_parent, child) => baseline(child?.id)),
    findMission: vi.fn(async (id) => children.get(id)),
    decide: vi.fn(async (value) => ({
      action: "execute" as const,
      goal: `Improve ${value.completedCycles + 1}`,
      reason: "Measured product gap",
      evidence: [`metric-window-${value.completedCycles + 1}`],
    })),
    runMission: vi.fn(async (_parent, id, goal) => {
      const child = mission(id, goal)
      children.set(id, child)
      return child
    }),
  }
  return { record, ports, children, saved }
}
