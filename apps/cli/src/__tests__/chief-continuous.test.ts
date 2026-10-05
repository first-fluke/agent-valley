import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { containerObservationPolicySchema } from "@agent-valley/core/chief/container-observation-policy"
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
    tasks: [],
    history: [],
    createdAt: now,
    updatedAt: now,
    verification: { ok: true, fingerprint: "verified", output: "checked" },
    finalReview: { passed: true, summary: "verified", findings: [] },
  }
}

describe("continuous operation CLI", () => {
  it("keeps two verified changes across cycles and preserves the original source checkout", async () => {
    const sourceHead = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout
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
        expect(await readFile(join(workspace.path, "service.txt"), "utf8")).toBe("login fixed\n")
        expect(await readFile(join(workspace.path, "new.txt"), "utf8")).toBe("retained untracked change\n")
        await writeFile(join(workspace.path, "service.txt"), "login and checkout fixed\n")
      }
      const mission = completedMission(id, goal, workspace)
      mission.verification = { ok: true, fingerprint: await fingerprintWorkspace(workspace.path) }
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
    expect(await readFile(join(root, "service.txt"), "utf8")).toBe("initial\n")
    expect((await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout).toBe(sourceHead)
    expect((await execute("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("")
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
})
