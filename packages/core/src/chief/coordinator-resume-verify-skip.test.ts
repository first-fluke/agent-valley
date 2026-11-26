import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCommand } from "../workspace/worktree-lifecycle"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { workspaceFileManifest } from "./fingerprint"
import { brief, fixture } from "./goal-supervision.fixture"
import { validateMission } from "./schemas"
import { executeGoalVerification, goalVerificationContractDigest } from "./verification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-resume-verify-skip-"))
  roots.push(root)
  for (const args of [
    ["init", "-q", "-b", "chief/resume-skip"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "AV Test"],
  ]) {
    const res = await runCommand("git", args, { cwd: root })
    if (res.exitCode !== 0) throw new Error(res.stderr)
  }
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(root, path), body, "utf8")
  }
  await runCommand("git", ["add", "-A"], { cwd: root })
  await runCommand("git", ["commit", "-q", "-m", "init"], { cwd: root })
  return root
}

describe("skip redundant verification on final-review resume", () => {
  it("skips verify and advances straight to final-review after a chief-unavailable final-review pause on an unchanged workspace", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    const originalRun = runAgent.getMockImplementation()
    let failFinal = true
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review" && failFinal) {
        failFinal = false
        throw new Error("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")
      }
      return (await originalRun?.(...args)) ?? ""
    })

    // First run completes work + review + verify, then pauses during final-review with chief-unavailable
    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(mission.execution?.failureKind).toBe("chief-unavailable")
    expect(mission.verification).toMatchObject({ ok: true, fingerprint: "change-1" })
    expect(mission.finalReview).toBeUndefined()
    expect(verify).toHaveBeenCalledTimes(1)

    // Simulate `av order --resume <id> --retry`
    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    if (resumed.execution) {
      resumed.execution.interventionAt = new Date().toISOString()
      delete resumed.execution.failureKind
      delete resumed.execution.pauseReason
      delete resumed.execution.nextRunAt
    }
    resumed.history.push({
      at: new Date().toISOString(),
      stage: "operator-intervention",
      message: "Operator resumed the original goal; prior decisions and checks were retained.",
    })

    const resumeOrder: string[] = []
    runAgent.mockClear()
    verify.mockClear()
    runAgent.mockImplementation(async (...args) => {
      resumeOrder.push(args[3])
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async () => {
      resumeOrder.push("verify")
      return { ok: true, output: "Unexpected redundant verify" }
    })

    await coordinate(resumed, ports)

    expect(resumed.status).toBe("completed")
    expect(resumeOrder).toEqual(["final-review"])
    expect(verify).not.toHaveBeenCalled()
    expect(resumed.finalReview?.passed).toBe(true)
    expect(resumed.verification).toMatchObject({ ok: true, fingerprint: "change-1" })
    expect(resumed.history.some((event) => event.stage === "verify-reused")).toBe(true)
  })

  it("skips verify on resume for chief-contract verification passed via flaky-rerun (exitCode 101 + nondeterministic)", async () => {
    const root = await gitRepo({ "harness.test.js": "test fixture\n", "report.md": "PASS\n" })
    const { mission, ports, runAgent, verify } = fixture()
    mission.workspace.path = root
    mission.workspace.branch = "chief/resume-skip"
    mission.verifyCommand = ""
    mission.verificationMode = "chief"
    mission.executionPolicy = executionPolicySchema.parse({})

    const criterion = brief.successCriteria[0] as string
    const contract = {
      version: 1 as const,
      criteria: [
        {
          criterion,
          checks: [
            {
              kind: "command" as const,
              program: "node" as const,
              args: ["--test", "harness.test.js"],
              timeoutMs: 120_000,
            },
            { kind: "file" as const, path: "report.md", minBytes: 4, contains: ["PASS"] },
          ],
        },
      ],
    }
    const contractSha = goalVerificationContractDigest(contract)

    const flakyRun = (verdicts: Record<string, "ok" | "FAILED">) => {
      const lines = Object.entries(verdicts).map(([name, verdict]) => `test ${name} ... ${verdict}`)
      const failures = Object.values(verdicts).filter((verdict) => verdict === "FAILED").length
      return {
        exitCode: 101,
        stdout: `running ${lines.length} tests\n${lines.join("\n")}\n\ntest result: FAILED. ${lines.length - failures} passed; ${failures} failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n`,
        stderr: "error: 1 target failed:\n    `-p arc-daemon --test suite`\n",
      }
    }

    const originalRun = runAgent.getMockImplementation()
    let failFinal = true
    let fp = (await workspaceFileManifest(root)).fingerprint
    ports.fingerprint = async () => fp

    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") {
        const planned = JSON.parse((await originalRun?.(...args)) ?? "{}")
        return JSON.stringify({ ...planned, verificationContract: contract })
      }
      if (args[3] === "work") {
        await writeFile(join(root, "report.md"), "PASS delivered\n", "utf8")
        fp = (await workspaceFileManifest(root)).fingerprint
        return "Delivered report.md"
      }
      if (args[3] === "final-review" && failFinal) {
        failFinal = false
        throw new Error("ENOTFOUND api.example.invalid")
      }
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async (currentMission) => {
      const executeCommand = vi
        .fn()
        .mockResolvedValueOnce(flakyRun({ t_a: "FAILED", t_b: "ok" }))
        .mockResolvedValueOnce(flakyRun({ t_a: "ok", t_b: "FAILED" }))
      currentMission.goalVerification = await executeGoalVerification(contract, root, {
        successCriteria: [criterion],
        expectedContractSha256: contractSha,
        executeCommand,
        commandReruns: 1,
      })
      return currentMission.goalVerification
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(mission.execution?.failureKind).toBe("chief-unavailable")
    expect(mission.goalVerification?.ok).toBe(true)
    expect(mission.goalVerification?.evidence[0]?.checks[0]).toMatchObject({
      passed: true,
      exitCode: 101,
      nondeterministic: ["t_a", "t_b"],
    })
    expect(verify).toHaveBeenCalledTimes(1)

    // Resume on exact unchanged workspace
    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    verify.mockClear()
    await coordinate(resumed, ports)

    expect(resumed.status).toBe("completed")
    expect(verify).not.toHaveBeenCalled()
    expect(resumed.history.some((event) => event.stage === "verify-reused")).toBe(true)
  })

  it("still runs verify on resume when the workspace fingerprint changed", async () => {
    const { mission, ports, runAgent, verify, mutate } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    const originalRun = runAgent.getMockImplementation()
    let failFinal = true
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review" && failFinal) {
        failFinal = false
        throw new Error("ENOTFOUND")
      }
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(verify).toHaveBeenCalledTimes(1)

    // Mutate workspace before resuming
    mutate("external-edit-after-verify")
    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    verify.mockClear()

    await coordinate(resumed, ports)
    expect(resumed.status).toBe("completed")
    expect(verify).toHaveBeenCalledTimes(1)
    expect(resumed.verification?.fingerprint).toBe("external-edit-after-verify")
    expect(resumed.history.some((event) => event.stage === "verify-reused")).toBe(false)
  })

  it("still runs verify on resume when a new operator note was recorded after verification", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    const originalRun = runAgent.getMockImplementation()
    let failFinal = true
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review" && failFinal) {
        failFinal = false
        throw new Error("ENOTFOUND")
      }
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(verify).toHaveBeenCalledTimes(1)

    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    resumed.operatorNotes = [
      {
        at: new Date(Date.now() + 1_000).toISOString(),
        text: "Updated sandbox environment; re-run verification checks.",
      },
    ]
    verify.mockClear()

    await coordinate(resumed, ports)
    expect(resumed.status).toBe("completed")
    expect(verify).toHaveBeenCalledTimes(1)
    expect(resumed.history.some((event) => event.stage === "verify-reused")).toBe(false)
  })

  it("still runs verify when final-review rejects after a reused verification and triggers a repair without fingerprint drift", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.maxRepairs = 1
    mission.executionPolicy = executionPolicySchema.parse({})
    const originalRun = runAgent.getMockImplementation()
    let finalReviewCalls = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review") {
        finalReviewCalls += 1
        if (finalReviewCalls === 1) throw new Error("ENOTFOUND")
        if (finalReviewCalls === 2) {
          const passedFinal = JSON.parse((await originalRun?.(...args)) ?? "{}")
          passedFinal.passed = false
          passedFinal.findings = ["onboarding still misses edge case"]
          passedFinal.criteria[0].passed = false
          return JSON.stringify(passedFinal)
        }
      }
      // Repair work intentionally does NOT change workspace fingerprint to test invalidation
      if (args[3] === "work" && args[2].repairRound === 1) return "Attempted repair without file delta"
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(verify).toHaveBeenCalledTimes(1)

    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    verify.mockClear()

    await coordinate(resumed, ports)
    expect(resumed.status).toBe("completed")
    // First resume skipped verify -> final-review rejected -> repair ran -> post-repair verify MUST run once!
    expect(verify).toHaveBeenCalledTimes(1)
    expect(resumed.repairRound).toBe(1)
    expect(resumed.history.some((event) => event.stage === "verify-reused")).toBe(true)
  })

  it("skips redundant review-gates and verify when resuming a final-review pause with current passing review gates", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    mission.operatingPolicy = {
      reviewVendor: "off",
      memory: false,
      reviewGates: [{ id: "maintenance", instructions: "Inspect module boundaries." }],
    }
    const originalRun = runAgent.getMockImplementation()
    let failFinal = true
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review" && failFinal) {
        failFinal = false
        throw new Error("ENOTFOUND")
      }
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(verify).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(1)

    const resumed = validateMission(structuredClone(mission))
    resumed.status = "pending"
    runAgent.mockClear()
    verify.mockClear()

    await coordinate(resumed, ports)
    expect(resumed.status).toBe("completed")
    expect(verify).not.toHaveBeenCalled()
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(0)
    expect(runAgent.mock.calls.filter((call) => call[3] === "final-review")).toHaveLength(1)
  })
})
