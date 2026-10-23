import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { automaticMissionRecovery } from "@agent-valley/core/chief/continuous-recovery"
import {
  assertExecutionBudget,
  assertNoUncertainExecution,
  executionPolicySchema,
} from "@agent-valley/core/chief/execution"
import type { OperatingRun } from "@agent-valley/core/chief/operations"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerChiefCommands } from "../chief"
import { reconcileMissionExecution, registerMissionReconciliation } from "../chief-reconcile"

let root: string
let store: MissionStore
let mission: Mission
const proof = "Task status is terminated; inspected the runtime task page and its final process log."
const options = { run: "uncertain-run", evidence: proof }
const recordPath = () => join(root, ".agent-valley", "missions", `${mission.id}.json`)
const exec = promisify(execFile)

const uncertainRun = (runId = options.run): OperatingRun => ({
  runId,
  taskId: "login",
  stage: "work",
  actorId: "worker",
  actorType: "claude",
  startedAt: new Date(Date.now() - 1_000).toISOString(),
  finishedAt: null,
  elapsedMs: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  outcome: "pending",
  executionState: "unknown",
  executionRecovery: "reconcile",
  evidence: "Submission response was lost after acceptance.",
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-reconcile-cli-"))
  store = new MissionStore(join(root, ".agent-valley", "missions"))
  mission = missionFixture()
  mission.status = "waiting"
  mission.executionPolicy = executionPolicySchema.parse({ autoResume: true, maxEstimatedCostUsd: 1 })
  mission.execution = {
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    runsStarted: 7,
    retries: 2,
    crashRestarts: 1,
    failureKind: "unknown-effect",
    pauseReason: "Runtime outcome is uncertain.",
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  }
  if (mission.tasks[0]) mission.tasks[0].status = "running"
  mission.operations = { runs: [uncertainRun()], routingEvidence: [], reviewDecisions: [] }
  await store.save(mission)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("operator execution reconciliation", () => {
  it("runs the source command with its normal guards, respects the live lock and leaves the mission paused", async () => {
    const checkout = resolve(import.meta.dirname, "../../../..")
    const args = [
      "--cwd",
      root,
      join(checkout, "apps/cli/src/index.ts"),
      "missions",
      "reconcile",
      mission.id,
      "--run",
      options.run,
      "--evidence",
      proof,
    ]
    const unlock = await store.lock(mission.id)
    try {
      await expect(exec("bun", args, { cwd: checkout, timeout: 10_000 })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("already running"),
      })
      expect((await store.load(mission.id)).operations?.runs[0]?.executionState).toBe("unknown")
    } finally {
      await unlock()
    }
    const result = await exec("bun", args, { cwd: checkout, timeout: 10_000 })
    expect(result.stdout).toContain("the mission remains paused")
    expect(result.stdout + result.stderr).not.toContain(proof)
    expect((await store.load(mission.id)).status).toBe("paused")
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "settled",
      outcome: "failed",
      costUsd: null,
    })
  })

  it("persists termination evidence, preserves the mission contract and spend, and leaves work paused", async () => {
    const before = structuredClone(mission)
    const result = await reconcileMissionExecution(mission.id, options, root)
    expect(await store.load(mission.id)).toEqual(result)
    expect(result.status).toBe("paused")
    expect(result.execution).toMatchObject({
      startedAt: before.execution?.startedAt,
      runsStarted: 7,
      retries: 2,
      crashRestarts: 1,
      failureKind: "interrupted",
    })
    expect(result.execution?.nextRunAt).toBeUndefined()
    expect(result.goal).toBe(before.goal)
    expect(result.personas).toEqual(before.personas)
    expect(result.plan).toEqual(before.plan)
    expect(result.tasks).toEqual(before.tasks)
    expect(result.verification).toEqual(before.verification)
    expect(result.finalReview).toEqual(before.finalReview)
    expect(result.executionPolicy).toEqual(before.executionPolicy)
    expect(result.operations?.runs).toHaveLength(1)
    expect(result.operations?.runs[0]).toMatchObject({
      executionState: "settled",
      outcome: "failed",
      finishedAt: expect.any(String),
      evidence: proof,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
    expect(result.history.slice(before.history.length)).toHaveLength(1)
    expect(JSON.parse(result.history.at(-1)?.message ?? "{}")).toMatchObject({
      runId: options.run,
      authority: "operator-recorded",
      evidence: proof,
    })
    expect(automaticMissionRecovery(result).retry).toBe(false)
    expect(() => assertExecutionBudget(result)).toThrow("Cost headroom is unknown")
  })

  it("keeps external effects unresolved even after execution termination is reconciled", async () => {
    if (mission.plan?.tasks[0]) mission.plan.tasks[0].effectScope = "external"
    if (mission.tasks[0]) mission.tasks[0].effectState = "running"
    await store.save(mission)
    const result = await reconcileMissionExecution(mission.id, options, root)
    expect(result.tasks[0]).toMatchObject({ effectState: "unknown", status: "running", attempts: 2 })
    expect(result.tasks[0]?.review).toEqual(mission.tasks[0]?.review)
    expect(result.status).toBe("paused")
  })

  it("does not unblock another uncertain execution", async () => {
    mission.operations?.runs.push(uncertainRun("another-uncertain-run"))
    await store.save(mission)
    const result = await reconcileMissionExecution(mission.id, options, root)
    expect(result.operations?.runs[1]?.executionState).toBe("unknown")
    expect(() => assertNoUncertainExecution(result)).toThrow("another-uncertain-run")
  })

  it.each([
    { run: "", evidence: proof },
    { run: " ", evidence: proof },
    { run: options.run, evidence: " " },
    { run: options.run, evidence: "x".repeat(2_001) },
    { run: "x".repeat(2_001), evidence: proof },
  ])("rejects incomplete or oversized evidence without writing the record", async (invalid) => {
    const before = await readFile(recordPath(), "utf8")
    await expect(reconcileMissionExecution(mission.id, invalid, root)).rejects.toThrow("--evidence")
    expect(await readFile(recordPath(), "utf8")).toBe(before)
  })

  it.each(["missing-run", options.run])("rejects a missing or already settled run %s", async (run) => {
    if (run === options.run && mission.operations?.runs[0]) mission.operations.runs[0].executionState = "settled"
    await store.save(mission)
    const before = await readFile(recordPath(), "utf8")
    await expect(reconcileMissionExecution(mission.id, { ...options, run }, root)).rejects.toThrow(
      "not an uncertain execution",
    )
    expect(await readFile(recordPath(), "utf8")).toBe(before)
  })

  it("refuses a live mission lock and releases its own lock after a rejected write", async () => {
    const unlock = await store.lock(mission.id)
    try {
      await expect(reconcileMissionExecution(mission.id, options, root)).rejects.toThrow("already running")
    } finally {
      await unlock()
    }
    const before = await readFile(recordPath(), "utf8")
    vi.spyOn(MissionStore.prototype, "save").mockRejectedValueOnce(new Error("Read-only storage"))
    await expect(reconcileMissionExecution(mission.id, options, root)).rejects.toThrow("Read-only storage")
    expect(await readFile(recordPath(), "utf8")).toBe(before)
    const unlockAgain = await store.lock(mission.id)
    await unlockAgain()
  })

  it("does not let operator evidence override an uncertain local process marker", async () => {
    const guard = store.processGuard(mission.id, options.run)
    guard.begin("work")
    const before = await readFile(recordPath(), "utf8")
    await expect(reconcileMissionExecution(mission.id, options, root)).rejects.toThrow("recording its Actor PID")
    expect(await readFile(recordPath(), "utf8")).toBe(before)
  })

  it("clears a proven stopped local process guard before recording operator evidence", async () => {
    if (mission.operations?.runs[0]) mission.operations.runs[0].executionRecovery = "local-process"
    await store.save(mission)
    const deadPid = 987_654_321
    const originalKill = process.kill.bind(process)
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (Math.abs(pid) === deadPid && signal === 0)
        throw Object.assign(new Error("No such process"), { code: "ESRCH" })
      return originalKill(pid, signal)
    })
    const guard = store.processGuard(mission.id, options.run)
    guard.begin("work")
    guard.spawned(deadPid, true)
    const result = await reconcileMissionExecution(mission.id, options, root)
    expect(result.operations?.runs[0]).toMatchObject({ executionState: "settled", evidence: proof })
    expect(JSON.parse(result.history.at(-1)?.message ?? "{}").authority).toBe("operator-recorded")
    expect(() => guard.assertIdle()).not.toThrow()
  })

  it("prevents a managed Actor from reconciling another mission", async () => {
    vi.stubEnv("AGENT_VALLEY_MANAGED_RUN", "1")
    await expect(reconcileMissionExecution(mission.id, options, root)).rejects.toThrow("already managed")
    expect((await store.load(mission.id)).operations?.runs[0]?.executionState).toBe("unknown")
  })
})

describe("missions reconcile command", () => {
  const program = () => {
    const command = new Command().exitOverride().configureOutput({ writeErr: () => {} })
    registerMissionReconciliation(command.command("missions").option("--watch"), root)
    return command
  }

  it("registers beneath the existing missions command and requires both evidence flags", async () => {
    const command = new Command()
    registerChiefCommands(command)
    const missions = command.commands.find((entry) => entry.name() === "missions")
    expect(missions?.commands.find((entry) => entry.name() === "reconcile")?.helpInformation()).toContain("--evidence")
    await expect(program().parseAsync(["missions", "reconcile", mission.id], { from: "user" })).rejects.toThrow(
      "required option",
    )
    expect((await store.load(mission.id)).operations?.runs[0]?.executionState).toBe("unknown")
  })

  it("records through Commander without starting mission supervision or a watcher", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await program().parseAsync(["missions", "reconcile", mission.id, "--run", options.run, "--evidence", proof], {
      from: "user",
    })
    expect((await store.load(mission.id)).status).toBe("paused")
    expect(log.mock.calls.flat().join("\n")).toContain(`av order --resume ${mission.id} --retry`)
    expect(log.mock.calls.flat().join("\n")).not.toContain(proof)
  })

  it("rejects combining reconciliation with watch", async () => {
    await expect(
      program().parseAsync(
        ["missions", "--watch", "reconcile", mission.id, "--run", options.run, "--evidence", proof],
        { from: "user" },
      ),
    ).rejects.toThrow("Omit --watch")
    expect((await store.load(mission.id)).operations?.runs[0]?.executionState).toBe("unknown")
  })
})
