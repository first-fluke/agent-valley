import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { containerObservationPolicySchema } from "@agent-valley/core/chief/container-observation-policy"
import { activeCharterAmendments } from "@agent-valley/core/chief/continuous-contract"
import { createContinuousMissionWorkspace } from "@agent-valley/core/chief/continuous-workspace"
import { fingerprintWorkspace } from "@agent-valley/core/chief/fingerprint"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeOperation, operationStore, renderOperationReport, runOperation } from "../chief-continuous"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({
  loadGlobalConfig: vi.fn(() => ({ agent: { type: "codex", model: "chosen-model" } })),
  loadProjectConfig: vi.fn(() => null),
}))
vi.mock("../agent-discovery", () => ({
  discoverAgents: vi.fn(async () => [{ agentType: "codex", installed: true, readiness: "ready", reason: "test" }]),
}))

const execute = promisify(execFile)
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-continuous-cli-")))
  await execute("git", ["init", "-q", root])
  await execute("git", ["config", "user.name", "AV test"], { cwd: root })
  await execute("git", ["config", "user.email", "av-test@example.invalid"], { cwd: root })
  await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
  await writeFile(join(root, "service.txt"), "initial\n")
  await execute("git", ["add", "."], { cwd: root })
  await execute("git", ["commit", "-qm", "initial"], { cwd: root })
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

function completedMission(id: string, goal: string, workspace: Mission["workspace"]): Mission {
  const now = new Date().toISOString()
  return {
    id,
    repositoryRoot: root,
    goal,
    chiefId: "chief-director",
    workspace,
    personas: [
      {
        id: "chief-director",
        name: "Chief Director",
        role: "Review",
        agentType: "codex",
        model: "chosen-model",
        skills: [],
      },
      { id: "reviewer", name: "Reviewer", role: "Independent review", agentType: "codex", skills: [] },
    ],
    verifyCommand: "git diff --check",
    timeoutSec: 10,
    maxRepairs: 1,
    status: "completed",
    goalBrief: { interpretation: goal, assumptions: [], successCriteria: ["Verified improvement"] },
    plan: {
      tasks: [
        {
          id: "work",
          title: "Improve",
          personaId: "chief-director",
          instructions: goal,
          acceptance: ["Verified improvement"],
          dependencies: [],
        },
      ],
    },
    fingerprint: "verified",
    tasks: [
      {
        id: "work",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "approved-task",
        review: { passed: true, summary: "Actual files inspected", findings: [] },
      },
    ],
    history: [],
    createdAt: now,
    updatedAt: now,
    verification: { ok: true, fingerprint: "verified", output: "checked" },
    finalReview: {
      passed: true,
      summary: "verified",
      findings: [],
      criteria: [{ criterion: "Verified improvement", passed: true, evidence: "Actual files and checks passed" }],
    },
  }
}

describe("continuous operation CLI", () => {
  it("applies two verified changes progressively to source while preserving its HEAD and index", async () => {
    const sourceHead = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout
    const sourceIndex = await readFile(join(root, ".git", "index"))
    const decisions = vi
      .fn()
      .mockResolvedValueOnce({
        action: "execute",
        goal: "Improve login",
        reason: "Observed login problem",
        evidence: ["issue login"],
      })
      .mockResolvedValueOnce({
        action: "execute",
        goal: "Improve checkout",
        reason: "Observed checkout problem",
        evidence: ["issue checkout"],
      })
    const child = vi.fn(async (operation, id: string, goal: string, baseline: string) => {
      const workspace = await createContinuousMissionWorkspace(root, operation.id, baseline, id, goal)
      if (goal === "Improve login") {
        await writeFile(join(workspace.path, "service.txt"), "login fixed\n")
        await writeFile(join(workspace.path, "new.txt"), "retained untracked change\n")
      } else {
        expect(await readFile(join(root, "service.txt"), "utf8")).toBe("login fixed\n")
        expect(await readFile(join(root, "new.txt"), "utf8")).toBe("retained untracked change\n")
        expect(await readFile(join(workspace.path, "service.txt"), "utf8")).toBe("login fixed\n")
        expect(await readFile(join(workspace.path, "new.txt"), "utf8")).toBe("retained untracked change\n")
        await writeFile(join(workspace.path, "service.txt"), "login and checkout fixed\n")
      }
      const mission = completedMission(id, goal, workspace)
      mission.verification = { ok: true, fingerprint: await fingerprintWorkspace(workspace.path) }
      mission.fingerprint = mission.verification.fingerprint
      await new MissionStore(join(root, ".agent-valley", "missions")).save(mission)
      return mission
    })
    const result = await runOperation(
      "Improve service and revenue",
      { workspace: root, cycles: "2", verify: "git diff --check" },
      root,
      { decide: decisions, runMission: child },
    )
    expect(result.phase, result.error).toBe("completed")
    expect(result.completedCycles).toBe(2)
    expect(result.settings).toMatchObject({ actor: "codex", model: "chosen-model", verify: "git diff --check" })
    expect(result.history.map((entry) => entry.goal)).toEqual(["Improve login", "Improve checkout"])
    expect(await readFile(join(result.baseline?.path ?? "", "service.txt"), "utf8")).toBe("login and checkout fixed\n")
    expect(await readFile(join(root, "service.txt"), "utf8")).toBe("login and checkout fixed\n")
    expect((await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout).toBe(sourceHead)
    expect(await readFile(join(root, ".git", "index"))).toEqual(sourceIndex)
    expect((await execute("git", ["status", "--porcelain"], { cwd: root })).stdout).toContain(" M service.txt")
    expect((await operationStore(root).load(result.id)).completedCycles).toBe(2)
    expect(await readFile(join(root, ".agent-valley", "operation-reports", `${result.id}.md`), "utf8")).toContain(
      "Verified completed improvements: 2 / 2",
    )
  }, 20_000)

  it("saves a stable identity and Chief model without starting decisions", async () => {
    const operation = await initializeOperation(
      "Improve continuously",
      { workspace: root, cycles: "3", interval: "123" },
      root,
      "assigned-operation",
    )
    expect(operation.id).toBe("assigned-operation")
    expect(operation.phase).toBe("deciding")
    expect(operation.waitIntervalSec).toBe(123)
    expect((await operationStore(root).load(operation.id)).settings).toMatchObject({
      actor: "codex",
      model: "chosen-model",
    })
    await expect(initializeOperation("different", { workspace: root }, root, operation.id)).rejects.toThrow(
      "already exists",
    )
  })

  it("renders bounded service evidence as untrusted text with health and resource context", async () => {
    const operation = await initializeOperation("Improve continuously", { workspace: root }, root)
    operation.containerObservationPolicy = containerObservationPolicySchema.parse({
      targets: [{ id: "api", kind: "docker", container: "api" }],
      cpu_percent_threshold: 80,
    })
    const now = new Date()
    operation.containerObservation = {
      collectedAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + 30_000).toISOString(),
      fingerprint: "a".repeat(64),
      results: [
        {
          targetId: "api",
          kind: "docker",
          status: "collected",
          state: "running",
          ready: true,
          cpuPercent: 95,
          logsAvailable: false,
          statsAvailable: true,
          issues: ["cpu-high"],
          logExcerpt: "![external image](https://example.invalid/tracker) <script>source evidence</script>",
          fingerprint: "a".repeat(64),
        },
      ],
    }
    operation.containerObservationRevision = 3
    const report = renderOperationReport(operation)
    expect(report).toContain("CPU=95%")
    expect(report).toContain("threshold 80")
    expect(report).toContain("logs=false")
    expect(report).toContain("Observation transition: 3")
    expect(report).toContain("&lt;script&gt;")
    expect(report).not.toContain("![external image]")
  })

  it("retains a paused child's identity and resumes acceptance after it is externally repaired", async () => {
    const decisions = vi.fn().mockResolvedValue({
      action: "execute",
      goal: "Repair login",
      reason: "Measured failure",
      evidence: ["failure evidence"],
    })
    const child = vi.fn(async (operation, id: string, goal: string, baseline: string) => {
      const workspace = await createContinuousMissionWorkspace(root, operation.id, baseline, id, goal)
      const mission = completedMission(id, goal, workspace)
      mission.status = "paused"
      mission.error = "Unknown external effect requires reconciliation"
      await new MissionStore(join(root, ".agent-valley", "missions")).save(mission)
      return mission
    })
    const paused = await runOperation("Improve continuously", { workspace: root, cycles: "1" }, root, {
      decide: decisions,
      runMission: child,
    })
    expect(paused.phase).toBe("paused")
    expect(paused.completedCycles).toBe(0)
    expect(paused.currentMissionId).toBeDefined()
    const samePaused = await runOperation(undefined, { resume: paused.id }, root, {
      decide: decisions,
      runMission: child,
    })
    expect(samePaused.currentMissionId).toBe(paused.currentMissionId)
    expect(child, samePaused.error).toHaveBeenCalledOnce()
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const repaired = await store.load(paused.currentMissionId ?? "")
    repaired.status = "completed"
    repaired.verification = { ok: true, fingerprint: await fingerprintWorkspace(repaired.workspace.path) }
    repaired.fingerprint = repaired.verification.fingerprint
    delete repaired.error
    await store.save(repaired)
    const completed = await runOperation(undefined, { resume: paused.id }, root, {
      decide: decisions,
      runMission: child,
    })
    expect(completed.phase).toBe("completed")
    expect(completed.completedCycles).toBe(1)
    expect(child).toHaveBeenCalledOnce()
    expect(decisions).toHaveBeenCalledOnce()
  })

  it("pauses interrupted waits with the due timestamp and no child launch", async () => {
    const controller = new AbortController()
    const decide = vi.fn().mockResolvedValue({ action: "wait", reason: "Need fresh GA observations" })
    const child = vi.fn()
    const result = await runOperation("Increase revenue", { workspace: root, interval: "300" }, root, {
      signal: controller.signal,
      decide,
      runMission: child,
      delay: async () => {
        controller.abort()
      },
    })
    expect(result.phase).toBe("paused")
    expect(result.nextRunAt).toBeDefined()
    expect(result.completedCycles).toBe(0)
    expect(decide).toHaveBeenCalledOnce()
    expect(child).not.toHaveBeenCalled()
    expect(renderOperationReport(result)).toContain("Need fresh GA observations")
  })

  it("rejects invalid limits and Actor overrides on resume", async () => {
    await expect(initializeOperation("Improve", { workspace: root, cycles: "0" }, root)).rejects.toThrow("--cycles")
    const operation = await initializeOperation("Improve", { workspace: root }, root)
    await expect(runOperation(undefined, { resume: operation.id, model: "different-model" }, root)).rejects.toThrow(
      "retains its Chief Director",
    )
  })

  it("records an operator charter correction on resume without rewriting the saved charter", async () => {
    const created = await initializeOperation("Improve", { workspace: root }, root)
    const controller = new AbortController()
    const decide = vi.fn().mockResolvedValue({ action: "wait", reason: "Need fresh observations" })
    const result = await runOperation(
      undefined,
      { resume: created.id, charterAppend: "The actor sandbox now permits /tmp writes." },
      root,
      {
        signal: controller.signal,
        decide,
        delay: async () => {
          controller.abort()
        },
      },
    )
    expect(result.charter).toBe("Improve")
    expect(result.completedCycles).toBe(0)
    expect(result.charterAmendments).toEqual([
      { id: 1, at: expect.any(String), text: "The actor sandbox now permits /tmp writes." },
    ])
    expect((await operationStore(root).load(created.id)).charterAmendments).toHaveLength(1)
    expect(renderOperationReport(result)).toContain("Charter amendment #1")
  })

  it("retracts an earlier amendment on the next resume and keeps both in the audit trail", async () => {
    const created = await initializeOperation("Improve", { workspace: root }, root)
    const decide = vi.fn().mockResolvedValue({ action: "wait", reason: "Need fresh observations" })
    // Each resume needs its own controller: the previous run aborted its own wait.
    const pausedRun = () => {
      const controller = new AbortController()
      return {
        signal: controller.signal,
        decide,
        delay: async () => {
          controller.abort()
        },
      }
    }
    await runOperation(undefined, { resume: created.id, charterAppend: "Avoid /tmp writes." }, root, pausedRun())
    const result = await runOperation(
      undefined,
      { resume: created.id, charterAppend: "/tmp writes are permitted.", charterSupersede: "1" },
      root,
      pausedRun(),
    )
    expect(result.charter).toBe("Improve")
    expect(activeCharterAmendments(result).map((entry) => entry.id)).toEqual([2])
    const report = renderOperationReport(result)
    expect(report).toContain("Charter amendment #1")
    expect(report).toContain("(superseded; retained for audit)")
    expect(report).toContain("Charter amendment #2")
  })

  it("rejects charter amendments outside an operation resume and invalid supersede targets", async () => {
    await expect(runOperation("Improve", { workspace: root, charterAppend: "Correction" }, root)).rejects.toThrow(
      "Charter amendments correct a saved operation",
    )
    const created = await initializeOperation("Improve", { workspace: root }, root)
    await expect(runOperation(undefined, { resume: created.id, charterSupersede: "1" }, root)).rejects.toThrow(
      "Add --charter-append",
    )
    await expect(
      runOperation(undefined, { resume: created.id, charterAppend: "Correction", charterSupersede: "0" }, root),
    ).rejects.toThrow("--charter-supersede takes comma-separated")
    await expect(
      runOperation(undefined, { resume: created.id, charterAppend: "Correction", charterSupersede: "9" }, root),
    ).rejects.toThrow("not recorded")
    expect((await operationStore(root).load(created.id)).charterAmendments).toBeUndefined()
  })

  it("retries a child paused with handoff-unavailable on operator --retry and clears operation.exhaustedProviders", async () => {
    const decisions = vi.fn().mockResolvedValue({
      action: "execute",
      goal: "Repair login",
      reason: "Measured failure",
      evidence: ["failure evidence"],
    })
    let childLaunch = 0
    const child = vi.fn(async (operation, id: string, goal: string, baseline: string) => {
      childLaunch += 1
      const workspace = await createContinuousMissionWorkspace(root, operation.id, baseline, id, goal)
      const mission = completedMission(id, goal, workspace)
      if (childLaunch === 1) {
        mission.status = "paused"
        mission.error = "Usage allowance exhausted"
        mission.execution = {
          startedAt: new Date().toISOString(),
          runsStarted: 2,
          retries: 0,
          failureKind: "handoff-unavailable",
          pauseReason: "Usage allowance exhausted",
        }
        mission.handoff = {
          exhaustedAgents: ["codex"],
          routes: {},
          continuations: {},
        }
      }
      await new MissionStore(join(root, ".agent-valley", "missions")).save(mission)
      return mission
    })
    const paused = await runOperation("Improve continuously", { workspace: root, cycles: "1" }, root, {
      decide: decisions,
      runMission: child,
    })
    expect(paused.phase).toBe("paused")
    expect(paused.exhaustedProviders).toBeDefined()
    expect(paused.currentMissionId).toBeDefined()

    const retryMission = vi.fn(async (missionId: string) => {
      const store = new MissionStore(join(root, ".agent-valley", "missions"))
      const mission = await store.load(missionId)
      delete mission.handoff
      mission.status = "completed"
      mission.verification = { ok: true, fingerprint: await fingerprintWorkspace(mission.workspace.path) }
      mission.fingerprint = mission.verification.fingerprint
      delete mission.error
      await store.save(mission)
      return mission
    })
    const resumed = await runOperation(undefined, { resume: paused.id, retry: true }, root, {
      decide: decisions,
      runMission: child,
      retryMission,
    })
    expect(resumed.phase).toBe("completed")
    expect(resumed.exhaustedProviders).toBeUndefined()
    expect(resumed.recovery).toBeUndefined()
    expect(retryMission).toHaveBeenCalledWith(paused.currentMissionId, expect.anything())
  })

  it("retries the legacy provider-exhaustion child without discarding its checkpoint or spent budget", async () => {
    const decisions = vi.fn().mockResolvedValue({
      action: "execute",
      goal: "Repair login",
      reason: "Measured failure",
      evidence: ["failure evidence"],
    })
    const providerExhaustionReason = "Usage allowance exhausted and no other installed, authenticated provider is ready"
    const child = vi.fn(async (operation, id: string, goal: string, baseline: string) => {
      const workspace = await createContinuousMissionWorkspace(root, operation.id, baseline, id, goal)
      const mission = completedMission(id, goal, workspace)
      mission.status = "paused"
      mission.error = providerExhaustionReason
      mission.execution = {
        startedAt: new Date().toISOString(),
        runsStarted: 2,
        retries: 1,
        failureKind: "budget",
        pauseReason: providerExhaustionReason,
      }
      mission.executionPolicy = {
        maxParallel: 1,
        maxDurationSec: 3_600,
        maxRuns: 10,
        maxEstimatedCostUsd: 5,
        maxRetries: 3,
        retryDelayMs: 1_000,
        autoResume: true,
      }
      mission.supervision = {
        maxRounds: 3,
        rounds: 1,
        stalledRounds: 0,
        decisions: [],
        originalAcceptance: ["Verified improvement"],
        pendingRecovery: { reason: providerExhaustionReason, taskId: "work" },
      }
      mission.handoff = { exhaustedAgents: ["claude"], routes: {}, continuations: {} }
      const task = mission.tasks.find((entry) => entry.id === "work")
      if (!task) throw new Error("Missing work task fixture")
      task.output = "Completed implementation before provider recovery"
      task.review = {
        passed: true,
        summary: "Actual files inspected",
        findings: [],
        criteria: [{ criterion: "Verified improvement", passed: true, evidence: "Retained task review evidence" }],
      }
      task.changeSet = {
        version: 1,
        inputTree: "a".repeat(40),
        deliveryTree: "b".repeat(40),
        files: [{ path: "service.txt", status: "modified", size: 12, sha256: "c".repeat(64) }],
        diff: "retained patch evidence",
        diffTruncated: false,
      }
      mission.operations = {
        runs: [
          {
            runId: "spent-run",
            stage: "work",
            actorId: "worker",
            actorType: "claude",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            elapsedMs: 100,
            inputTokens: 10,
            outputTokens: 20,
            costUsd: 0.25,
            outcome: "failed",
            executionState: "settled",
            evidence: "Provider usage allowance was exhausted.",
          },
        ],
        routingEvidence: [],
        reviewDecisions: [],
      }
      await new MissionStore(join(root, ".agent-valley", "missions")).save(mission)
      return mission
    })
    const paused = await runOperation("Improve continuously", { workspace: root, cycles: "1" }, root, {
      decide: decisions,
      runMission: child,
    })
    expect(paused.phase).toBe("paused")
    expect(paused.currentMissionId).toBeDefined()
    expect(paused.exhaustedProviders).toEqual([{ agentType: "claude", at: expect.any(String) }])
    expect(paused.recovery?.disposition).toBe("protected")

    const retryMission = vi.fn(async (missionId: string) => {
      const store = new MissionStore(join(root, ".agent-valley", "missions"))
      const mission = await store.load(missionId)
      expect(mission.tasks[0]).toMatchObject({
        output: "Completed implementation before provider recovery",
        changeSet: { diff: "retained patch evidence" },
        review: {
          passed: true,
          summary: "Actual files inspected",
          criteria: [{ evidence: "Retained task review evidence" }],
        },
      })
      expect(mission.execution).toMatchObject({ runsStarted: 2, retries: 1 })
      expect(mission.executionPolicy).toMatchObject({ maxRuns: 10, maxEstimatedCostUsd: 5 })
      expect(mission.operations?.runs).toMatchObject([
        { runId: "spent-run", costUsd: 0.25, inputTokens: 10, outputTokens: 20 },
      ])
      delete mission.handoff
      delete mission.error
      if (mission.execution) {
        delete mission.execution.failureKind
        delete mission.execution.pauseReason
        delete mission.execution.nextRunAt
      }
      mission.status = "completed"
      mission.verification = { ok: true, fingerprint: await fingerprintWorkspace(mission.workspace.path) }
      mission.fingerprint = mission.verification.fingerprint
      await store.save(mission)
      return mission
    })
    const resumed = await runOperation(undefined, { resume: paused.id, retry: true }, root, {
      decide: decisions,
      runMission: child,
      retryMission,
    })
    expect(retryMission).toHaveBeenCalledOnce()
    expect(retryMission).toHaveBeenCalledWith(paused.currentMissionId, expect.anything())
    expect(child).toHaveBeenCalledOnce()
    expect(resumed.phase, resumed.error).toBe("completed")
    expect(resumed.exhaustedProviders).toBeUndefined()
    expect(resumed.recovery).toBeUndefined()
    expect(retryMission).toHaveBeenCalledWith(paused.currentMissionId, expect.anything())
    const saved = await new MissionStore(join(root, ".agent-valley", "missions")).load(paused.currentMissionId ?? "")
    expect(saved.tasks[0]).toMatchObject({
      output: "Completed implementation before provider recovery",
      changeSet: { diff: "retained patch evidence" },
      review: { criteria: [{ evidence: "Retained task review evidence" }] },
    })
    expect(saved.execution).toMatchObject({ runsStarted: 2, retries: 1 })
    expect(saved.operations?.runs[0]).toMatchObject({
      runId: "spent-run",
      costUsd: 0.25,
      evidence: "Provider usage allowance was exhausted.",
    })
  })

  it("keeps a genuine child budget pause protected and directs operators to the child checkpoint", async () => {
    const decisions = vi.fn().mockResolvedValue({
      action: "execute",
      goal: "Repair login",
      reason: "Measured failure",
      evidence: ["failure evidence"],
    })
    const child = vi.fn(async (operation, id: string, goal: string, baseline: string) => {
      const workspace = await createContinuousMissionWorkspace(root, operation.id, baseline, id, goal)
      const mission = completedMission(id, goal, workspace)
      mission.status = "paused"
      mission.error = "Mission Actor call limit reached."
      mission.execution = {
        startedAt: new Date().toISOString(),
        runsStarted: 10,
        retries: 0,
        failureKind: "budget",
        pauseReason: mission.error,
      }
      mission.executionPolicy = {
        maxParallel: 1,
        maxDurationSec: 3_600,
        maxRuns: 10,
        maxRetries: 3,
        retryDelayMs: 1_000,
        autoResume: true,
      }
      await new MissionStore(join(root, ".agent-valley", "missions")).save(mission)
      return mission
    })
    const paused = await runOperation("Improve continuously", { workspace: root, cycles: "1" }, root, {
      decide: decisions,
      runMission: child,
    })
    const retryMission = vi.fn()
    await expect(
      runOperation(undefined, { resume: paused.id, retry: true }, root, {
        decide: decisions,
        runMission: child,
        retryMission,
      }),
    ).rejects.toThrow("Resume the current child directly with av order --resume")
    expect(retryMission).not.toHaveBeenCalled()
    const saved = await new MissionStore(join(root, ".agent-valley", "missions")).load(paused.currentMissionId ?? "")
    expect(saved.status).toBe("paused")
    expect(saved.execution).toMatchObject({ failureKind: "budget", runsStarted: 10 })
    expect(saved.executionPolicy?.maxRuns).toBe(10)
  })
})
