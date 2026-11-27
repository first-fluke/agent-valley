import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import { runCommand } from "../workspace/worktree-lifecycle"
import { verifiedMissionEvidence } from "./continuous-recovery"
import { coordinate } from "./coordinator"
import { selectVerificationRepairScope } from "./coordinator-state"
import { planPrompt } from "./prompts"
import { verificationIncompleteReasons } from "./report-verification"
import { renderReport } from "./reports"
import { ChiefRuntime } from "./runtime"
import { validateMission } from "./schemas"
import { MissionStore } from "./store"
import type { ChiefPorts, Mission } from "./types"
import {
  executeGoalVerification,
  goalVerificationContractDigest,
  validateGoalVerificationContract,
  validateGoalVerificationResult,
} from "./verification"
import { canReusePriorVerification } from "./verification-reuse"

const dirs: string[] = []

async function makeGitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-verification-waiver-"))
  dirs.push(root)
  for (const args of [
    ["init", "-b", "chief/waiver"],
    ["config", "user.name", "AV Test"],
    ["config", "user.email", "av-test@example.invalid"],
  ]) {
    const res = await runCommand("git", args, { cwd: root })
    if (res.exitCode !== 0) throw new Error(res.stderr)
  }
  await writeFile(join(root, "baseline.txt"), "baseline\n")
  await runCommand("git", ["add", "baseline.txt"], { cwd: root })
  await runCommand("git", ["commit", "-m", "baseline"], { cwd: root })
  return root
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const c1 = "Primary deliverable exists"
const c2 = "External vendor total reaches 32/0/4/7"
const twoCriteriaContract = validateGoalVerificationContract(
  {
    version: 1,
    criteria: [
      { criterion: c1, checks: [{ kind: "file", path: "deliverable.md", contains: ["PASS"] }] },
      { criterion: c2, checks: [{ kind: "file", path: "counts.md", contains: ["32/0/4/7"] }] },
    ],
  },
  [c1, c2],
)

describe("Chief verification criterionWaivers", () => {
  it("truthfully records waived unmet criteria while returning ok: true only when all non-waived criteria pass", async () => {
    const root = await makeGitWorkspace()
    await writeFile(join(root, "deliverable.md"), "PASS\n")
    await writeFile(join(root, "counts.md"), "Honest partial count: 31/1/4/7\n")

    // Without waiver -> fails
    const unwaived = await executeGoalVerification(twoCriteriaContract, root, { successCriteria: [c1, c2] })
    expect(unwaived.ok).toBe(false)
    expect(unwaived.evidence[1]).toMatchObject({ criterion: c2, passed: false })
    expect(unwaived.evidence[1]?.waived).toBeUndefined()
    expect(unwaived.output).toContain(`FAIL ${c2}`)

    // With waiver for c2 -> ok: true, c2 still recorded passed: false + waived: true + honest failure summary
    const waived = await executeGoalVerification(twoCriteriaContract, root, {
      successCriteria: [c1, c2],
      waivedCriteria: new Set([c2]),
    })
    expect(waived.ok).toBe(true)
    expect(waived.evidence[0]).toMatchObject({ criterion: c1, passed: true })
    expect(waived.evidence[0]?.waived).toBeUndefined()
    expect(waived.evidence[1]).toMatchObject({ criterion: c2, passed: false, waived: true })
    expect(waived.evidence[1]?.checks[0]?.passed).toBe(false)
    expect(waived.evidence[1]?.checks[0]?.summary).toContain('lacks required text "32/0/4/7"')
    expect(waived.output).toContain(`PASS ${c1}`)
    expect(waived.output).toContain(`WAIVED (UNMET) ${c2}`)

    // Passing criterion is never marked waived even if listed in waivedCriteria
    const bothWaived = await executeGoalVerification(twoCriteriaContract, root, {
      successCriteria: [c1, c2],
      waivedCriteria: new Set([c1, c2]),
    })
    expect(bothWaived.evidence[0]?.passed).toBe(true)
    expect(bothWaived.evidence[0]?.waived).toBeUndefined()

    // If a non-waived criterion ALSO fails, ok remains false
    await writeFile(join(root, "deliverable.md"), "INCOMPLETE\n")
    const nonWaivedFails = await executeGoalVerification(twoCriteriaContract, root, {
      successCriteria: [c1, c2],
      waivedCriteria: new Set([c2]),
    })
    expect(nonWaivedFails.ok).toBe(false)
    expect(nonWaivedFails.evidence[0]).toMatchObject({ criterion: c1, passed: false })
    expect(nonWaivedFails.evidence[0]?.waived).toBeUndefined()
    expect(nonWaivedFails.evidence[1]).toMatchObject({ criterion: c2, passed: false, waived: true })
  })

  it("rejects spoofed waivers or waived: true on passing criteria in validateGoalVerificationResult", async () => {
    const root = await makeGitWorkspace()
    await writeFile(join(root, "deliverable.md"), "PASS\n")
    await writeFile(join(root, "counts.md"), "31/1/4/7\n")

    const waivedResult = await executeGoalVerification(twoCriteriaContract, root, {
      successCriteria: [c1, c2],
      waivedCriteria: new Set([c2]),
    })

    // Missing or non-matching waivedCriteria -> rejected
    expect(() => validateGoalVerificationResult(waivedResult, twoCriteriaContract)).toThrow(/waived/)
    expect(() => validateGoalVerificationResult(waivedResult, twoCriteriaContract, new Set([c1]))).toThrow(/waived/)
    expect(validateGoalVerificationResult(waivedResult, twoCriteriaContract, new Set([c2])).ok).toBe(true)

    // Spoofed waived: true on a passing criterion -> rejected even if criterion is in waivedCriteria
    const spoofedPassing = structuredClone(waivedResult)
    if (spoofedPassing.evidence[0]) spoofedPassing.evidence[0].waived = true
    expect(() => validateGoalVerificationResult(spoofedPassing, twoCriteriaContract, new Set([c1, c2]))).toThrow(
      /waived/,
    )
  })

  it("ignores waived criteria in selectVerificationRepairScope and targets only non-waived failing criteria", async () => {
    const root = await makeGitWorkspace()
    await writeFile(join(root, "deliverable.md"), "BROKEN\n")
    await writeFile(join(root, "counts.md"), "31/1/4/7\n")

    const goalVerification = await executeGoalVerification(twoCriteriaContract, root, {
      successCriteria: [c1, c2],
      waivedCriteria: new Set([c2]),
    })
    expect(goalVerification.ok).toBe(false)

    const mission = {
      plan: {
        tasks: [
          {
            id: "task-deliverable",
            title: "Build deliverable.md",
            personaId: "actor",
            instructions: "Write deliverable.md",
            acceptance: [c1],
            dependencies: [],
          },
          {
            id: "task-counts",
            title: "Build counts.md",
            personaId: "actor",
            instructions: "Write counts.md",
            acceptance: [c2],
            dependencies: [],
          },
        ],
      },
      tasks: [
        {
          id: "task-deliverable",
          reviewerId: "chief",
          status: "completed",
          attempts: 1,
          changeSet: { files: [{ path: "deliverable.md", status: "added", bytes: 7, sha256: "a".repeat(64) }] },
        },
        {
          id: "task-counts",
          reviewerId: "chief",
          status: "completed",
          attempts: 1,
          changeSet: { files: [{ path: "counts.md", status: "added", bytes: 9, sha256: "b".repeat(64) }] },
        },
      ],
      goalVerification,
    } as unknown as Mission

    const scope = selectVerificationRepairScope(mission)
    expect(scope).toEqual(new Set(["task-deliverable"]))
  })

  it("completes end-to-end Chief mission with criterionWaivers, passes validateMission, verifiedMissionEvidence, reuse, and renders cleanly", async () => {
    const root = await makeGitWorkspace()
    const initialFingerprint = await fingerprintWorkspace(root)
    const mission: Mission = {
      id: "waiver-e2e",
      goal: "Deliver primary artifact and document honest counts",
      chiefId: "chief",
      personas: [
        { id: "chief", name: "Chief Director", role: "Supervise", agentType: "codex", skills: [] },
        { id: "actor", name: "Actor", role: "Implement", agentType: "codex", skills: [] },
      ],
      workspace: {
        issueId: "waiver-e2e",
        path: root,
        key: "waiver-e2e",
        branch: "chief/waiver",
        status: "idle",
        createdAt: "2026-10-03",
      },
      verifyCommand: "",
      verificationMode: "chief",
      verificationContract: structuredClone(twoCriteriaContract),
      verificationContractSha256: goalVerificationContractDigest(twoCriteriaContract),
      goalBrief: {
        interpretation: "Deliver primary artifact and honest counts",
        assumptions: [],
        successCriteria: [c1, c2],
      },
      criterionWaivers: [
        {
          at: "2026-10-03T12:00:00.000Z",
          criterion: c2,
          reason: "External vendor docs expose no tool-call id; honest count is 31/1/4/7.",
        },
      ],
      supervision: { maxRounds: 1, rounds: 0, stalledRounds: 0, decisions: [], originalAcceptance: [c1, c2] },
      initialFingerprint,
      timeoutSec: 5,
      maxRepairs: 0,
      status: "pending",
      createdAt: "2026-10-03",
      updatedAt: "2026-10-03",
      plan: {
        tasks: [
          {
            id: "deliver",
            title: "Write deliverables",
            personaId: "actor",
            instructions: "Write deliverable.md and counts.md",
            acceptance: [c1, c2],
            dependencies: [],
          },
        ],
      },
      tasks: [{ id: "deliver", reviewerId: "chief", status: "pending", attempts: 0 }],
      history: [],
    }

    const runtime = new ChiefRuntime(new MissionStore(join(root, ".agent-valley/missions")))
    const ports: ChiefPorts = {
      ...runtime.ports(),
      save: vi.fn(async () => {}),
      runAgent: vi.fn(async (_actor, _prompt, value, stage) => {
        if (stage === "work") {
          await writeFile(join(value.workspace.path, "deliverable.md"), "PASS\n")
          await writeFile(join(value.workspace.path, "counts.md"), "31/1/4/7\n")
          return "Delivered deliverable.md and honest counts.md."
        }
        if (stage === "final-review") {
          return JSON.stringify({
            passed: true,
            summary: "Primary criterion passed; second criterion waived by operator.",
            findings: [],
            criteria: [
              { criterion: c1, passed: true, evidence: "deliverable.md contains PASS." },
              { criterion: c2, passed: false, waived: true, evidence: "counts.md records 31/1/4/7; operator waived." },
            ],
          })
        }
        return JSON.stringify({ passed: true, summary: "Task deliverable verified.", findings: [] })
      }),
    }

    try {
      await coordinate(mission, ports)
    } finally {
      await runtime.close()
    }

    expect(mission.status).toBe("completed")
    expect(mission.verification?.ok).toBe(true)
    expect(mission.goalVerification?.ok).toBe(true)
    expect(mission.goalVerification?.evidence[1]).toMatchObject({ criterion: c2, passed: false, waived: true })
    expect(mission.finalReview?.passed).toBe(true)
    expect(mission.finalReview?.criteria?.[1]).toMatchObject({ criterion: c2, passed: false, waived: true })

    // Persisted validation succeeds with matching waiver, and fails if waiver is stripped
    expect(() => validateMission(structuredClone(mission))).not.toThrow()
    const stripped = structuredClone(mission)
    delete stripped.criterionWaivers
    expect(() => validateMission(stripped)).toThrow(/waived/)

    // Continuous recovery evidence check and report rendering both recognize the waived completion
    expect(verifiedMissionEvidence(mission)).toBe(true)
    expect(verificationIncompleteReasons(mission)).toEqual([])
    const rendered = renderReport(mission)
    expect(rendered).toContain("판정: 완료")
    expect(rendered).toContain("미달\\(운영자 면제\\)")

    // Prior-verification reuse recognizes a waived passing verification before final approval
    const preApproval = structuredClone(mission)
    preApproval.status = "verifying"
    delete preApproval.finalReview
    expect(canReusePriorVerification(preApproval, mission.fingerprint as string)).toBe(true)

    // planPrompt warns against hardcoding conditional optimistic counts
    expect(planPrompt(mission)).toContain("Never hardcode conditional or optimistic aggregate counts")
  })
})
