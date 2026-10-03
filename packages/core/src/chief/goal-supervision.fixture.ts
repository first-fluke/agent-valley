import { vi } from "vitest"
import { fallbackReport } from "./reports"
import { finalCriteria } from "./schemas"
import type { ChiefPlan, ChiefPorts, GoalBrief, Mission } from "./types"

export const brief: GoalBrief = {
  interpretation: "Make onboarding easy enough for a first-time user to complete without help.",
  assumptions: ["Use the existing onboarding flow and preserve current account permissions."],
  successCriteria: ["A first-time user can complete onboarding with documented evidence."],
}
export const plan: ChiefPlan = {
  tasks: [
    {
      id: "onboarding",
      title: "Improve onboarding",
      personaId: "worker",
      instructions: "Update the onboarding flow and write a reproducible acceptance check.",
      acceptance: ["Onboarding has a reproducible passing acceptance check."],
      dependencies: [],
    },
  ],
}
export const passed = JSON.stringify({
  passed: true,
  summary: "Inspected onboarding.ts and acceptance evidence.",
  findings: [],
})
export const rejected = JSON.stringify({
  passed: false,
  summary: "The first-time flow is incomplete.",
  findings: ["Handle the empty-account onboarding state."],
})

export function fixture() {
  const mission: Mission = {
    id: "goal-mission",
    goal: "Make this app easy to start using",
    chiefId: "chief",
    personas: [
      {
        id: "chief",
        name: "Chief Director",
        role: "Own the outcome",
        agentType: "codex",
        model: "operator-model",
        skills: [],
      },
      { id: "worker", name: "Worker", role: "Improve onboarding", agentType: "cursor", skills: [] },
      { id: "reviewer", name: "Reviewer", role: "Inspect acceptance evidence", agentType: "claude", skills: [] },
    ],
    workspace: {
      issueId: "goal-mission",
      path: "/workspace/goal-mission",
      key: "goal-mission",
      branch: "chief/goal-mission",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "bun test",
    timeoutSec: 300,
    maxRepairs: 0,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
    supervision: { maxRounds: 8, rounds: 0, stalledRounds: 0, decisions: [] },
  }
  let fingerprint = "initial"
  let work = 0
  const snapshots: Mission[] = []
  const runAgent = vi.fn<ChiefPorts["runAgent"]>(async (_actor, _prompt, value, stage) => {
    if (stage === "plan") return JSON.stringify({ ...plan, goalBrief: brief })
    if (stage === "work") {
      fingerprint = `change-${++work}`
      return "Changed onboarding.ts; a first-time empty account now reaches the welcome page."
    }
    if (stage === "final-review")
      return JSON.stringify({
        passed: true,
        summary: "Goal and original acceptance evidence inspected.",
        findings: [],
        criteria: finalCriteria(value).map((criterion) => ({
          criterion,
          passed: true,
          evidence: "onboarding.ts and passing acceptance check inspected.",
        })),
      })
    if (stage === "supervise")
      return JSON.stringify({
        action: "repair",
        reason: "Repair the missing state using recorded evidence.",
        instructions: "Handle the empty-account state and verify onboarding.",
      })
    if (stage === "report") return JSON.stringify(fallbackReport(value))
    return passed
  })
  const verify = vi.fn<ChiefPorts["verify"]>(async () => ({ ok: true, output: "Onboarding acceptance check passed" }))
  const ports: ChiefPorts = {
    runAgent,
    verify,
    fingerprint: async () => fingerprint,
    save: async (value) => {
      snapshots.push(structuredClone(value))
    },
  }
  return {
    mission,
    ports,
    runAgent,
    verify,
    snapshots,
    mutate: (value: string) => {
      fingerprint = value
    },
  }
}
