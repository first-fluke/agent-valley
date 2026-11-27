import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { recordIntegrationCheck } from "./coordinator-integration"
import { brief, fixture, passed, rejected } from "./goal-supervision.fixture"
import { INTEGRATION_CHECK_RULE } from "./prompts"
import {
  combinedIntegrationResult,
  INTEGRATION_CHANGED_FILES_FILE_ENV,
  INTEGRATION_OPEN_TASKS_ENV,
  INTEGRATION_TASK_IDS_ENV,
  integrationCheckCommand,
  integrationCheckContextEnv,
  integrationCheckEnabled,
  integrationEvidenceFor,
  operatorIntegrationResult,
  reusableEvidence,
} from "./runtime-integration-check"
import { validateMission } from "./schemas"
import type { IntegrationCheckContext } from "./types"
import { executeCommandChecks, executeGoalVerification, safeVerificationCommand } from "./verification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function codeFixture() {
  const value = fixture()
  const worker = value.mission.personas.find((persona) => persona.id === "worker")
  if (!worker) throw new Error("Expected the fixture worker")
  worker.skills = ["oma-backend"]
  return value
}

describe("integration check between task delivery and review", () => {
  it("runs the contract commands before review and gives the reviewer the observed failure", async () => {
    const { mission, ports, runAgent } = codeFixture()
    mission.maxRepairs = 1
    const check = vi.fn(async () => ({ ok: false, output: "cargo test --workspace\nFAIL: legacy_fixture ... FAILED" }))
    ports.integrationCheck = check
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") {
        expect(args[1]).toContain(INTEGRATION_CHECK_RULE)
        if (reviews++ === 0) {
          expect(args[1]).toContain("legacy_fixture ... FAILED")
          check.mockResolvedValue({ ok: true, output: "cargo test --workspace\nPASS: all tests" })
          return rejected
        }
        expect(args[1]).toContain("PASS: all tests")
        return passed
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    // One check per delivery: the first attempt and its repair, never one per review retry.
    expect(check).toHaveBeenCalledTimes(2)
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.integrationCheck?.ok).toBe(true)
    expect(mission.history.filter((event) => event.stage === "integration-check")).toHaveLength(2)
  })

  it("skips tasks without a code skill and survives a check that cannot run", async () => {
    const documentation = fixture()
    const unused = vi.fn(async () => ({ ok: true, output: "unused" }))
    documentation.ports.integrationCheck = unused
    await coordinate(documentation.mission, documentation.ports)
    expect(unused).not.toHaveBeenCalled()

    const { mission, ports, runAgent } = codeFixture()
    ports.integrationCheck = vi.fn(async () => {
      throw new Error("cargo is not installed")
    })
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.integrationCheck).toBeUndefined()
    expect(runAgent.mock.calls.find((call) => call[3] === "review")?.[1]).not.toContain(INTEGRATION_CHECK_RULE)
    expect(mission.history.find((event) => event.stage === "integration-check")?.message).toContain("skipped")
  })

  it("is enabled only by AV_INTEGRATION_CHECK=1", () => {
    expect(integrationCheckEnabled({})).toBe(false)
    expect(integrationCheckEnabled({ AV_INTEGRATION_CHECK: "0" })).toBe(false)
    expect(integrationCheckEnabled({ AV_INTEGRATION_CHECK: "1" })).toBe(true)
  })

  it("lets the operator supply the project's own gate command, which also enables the check", () => {
    expect(integrationCheckCommand({})).toBeUndefined()
    expect(integrationCheckCommand({ AV_INTEGRATION_CHECK_COMMAND: "  " })).toBeUndefined()
    const env = { AV_INTEGRATION_CHECK_COMMAND: " cargo test --workspace && ./scripts/harness/validate.sh " }
    expect(integrationCheckCommand(env)).toBe("cargo test --workspace && ./scripts/harness/validate.sh")
    expect(integrationCheckEnabled(env)).toBe(true)
    expect(operatorIntegrationResult("make gate", { ok: true, output: "noise" })).toEqual({
      ok: true,
      output: "make gate\nPASS: the operator's integration command exited zero.",
    })
    const failed = operatorIntegrationResult("make gate", {
      ok: false,
      output: `${"x".repeat(20_000)}harness: layer violation`,
    })
    expect(failed.ok).toBe(false)
    expect(failed.output).toContain("exited nonzero")
    expect(failed.output.endsWith("harness: layer violation")).toBe(true)
    expect(failed.output.length).toBeLessThanOrEqual(8_000)
    expect(operatorIntegrationResult("make gate", { ok: false, output: "", timedOut: true }).output).toContain(
      "timed out",
    )
    // The failing step of a long chained gate is above the retained tail; the result names the complete log.
    const logged = operatorIntegrationResult(
      "make gate",
      { ok: false, output: "last passing step" },
      "/work/.agent-valley/integration-checks/2026-11-18T06-00-00-000Z.log",
    )
    expect(logged.output).toContain(
      "Complete output of this check: /work/.agent-valley/integration-checks/2026-11-18T06-00-00-000Z.log",
    )
    expect(logged.output.endsWith("last passing step")).toBe(true)
  })
})

describe("command-only contract checks", () => {
  it("runs each distinct command once, ignores file and JSON checks and reports failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-integration-check-"))
    roots.push(root)
    await writeFile(join(root, "a.test.js"), "")
    const command = { kind: "command", program: "node", args: ["--test", "a.test.js"] }
    const contract = {
      version: 1,
      criteria: [
        { criterion: "Tests pass", checks: [command, { kind: "file", path: "missing-evidence.json", minBytes: 1 }] },
        { criterion: "Tests still pass", checks: [command] },
      ],
    }
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
    const options = { successCriteria: ["Tests pass", "Tests still pass"], executeCommand }
    expect(await executeCommandChecks(contract, root, options)).toMatchObject({ ok: true })
    expect(executeCommand).toHaveBeenCalledOnce()
    executeCommand.mockResolvedValueOnce({ exitCode: 1, stdout: "test legacy ... FAILED", stderr: "" })
    const failed = await executeCommandChecks(contract, root, options)
    expect(failed?.ok).toBe(false)
    expect(failed?.output).toContain("node --test a.test.js")
    expect(failed?.output).toContain("legacy ... FAILED")
    const filesOnly = { version: 1, criteria: [{ criterion: "Tests pass", checks: [contract.criteria[0]?.checks[1]] }] }
    expect(await executeCommandChecks(filesOnly, root, { successCriteria: ["Tests pass"] })).toBeUndefined()
  })
})

describe("verification reuses integration evidence from the identical workspace", () => {
  const command = { kind: "command", program: "node", args: ["--test", "a.test.js"] }
  const contract = { version: 1, criteria: [{ criterion: "Tests pass", checks: [command] }] }
  const successCriteria = ["Tests pass"]

  async function observed() {
    const root = await mkdtemp(join(tmpdir(), "av-integration-evidence-"))
    roots.push(root)
    await writeFile(join(root, "a.test.js"), "// first")
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
    const check = await executeCommandChecks(contract, root, { successCriteria, executeCommand })
    if (!check) throw new Error("Expected a command check result")
    return { root, executeCommand, check }
  }

  it("does not run a command again while its evidence and inputs are unchanged", async () => {
    const { root, executeCommand, check } = await observed()
    const evidence = reusableEvidence(check, "same", "same", new Date("2026-01-01T00:00:00Z"))
    expect(evidence).toMatchObject({ fingerprint: "same", checkedAt: "2026-01-01T00:00:00.000Z" })
    const result = await executeGoalVerification(contract, root, {
      successCriteria,
      executeCommand,
      reuse: evidence?.checks,
    })
    expect(executeCommand).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(result.evidence[0]?.checks[0]).toMatchObject({
      passed: true,
      exitCode: 0,
      outputSha256: check.evidence[0]?.outputSha256,
    })
    expect(result.evidence[0]?.checks[0]?.summary).toContain("reused")
  })

  it("runs the command again when a bound input changed or the earlier run failed", async () => {
    const { root, executeCommand, check } = await observed()
    await writeFile(join(root, "a.test.js"), "// second")
    await executeGoalVerification(contract, root, { successCriteria, executeCommand, reuse: check.evidence })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    const failed = check.evidence.map((entry) => ({ ...entry, passed: false, exitCode: 1 }))
    await executeGoalVerification(contract, root, { successCriteria, executeCommand, reuse: failed })
    expect(executeCommand).toHaveBeenCalledTimes(3)
  })

  it("keeps evidence only for a fully passing check that left the workspace unchanged", async () => {
    const { check } = await observed()
    expect(reusableEvidence(check, "before", "after")).toBeUndefined()
    expect(reusableEvidence({ ...check, ok: false }, "same", "same")).toBeUndefined()
    const partial = [...check.evidence, { ...check.evidence[0], passed: false, exitCode: 1 }] as typeof check.evidence
    expect(reusableEvidence({ ok: true, evidence: partial }, "same", "same")).toBeUndefined()
    expect(reusableEvidence({ ok: true, evidence: [] }, "same", "same")).toBeUndefined()
  })

  it("offers evidence only while the workspace fingerprint still matches", async () => {
    const { mission } = codeFixture()
    const { check } = await observed()
    expect(await integrationEvidenceFor(mission, async () => "same")).toBeUndefined()
    mission.integrationEvidence = reusableEvidence(check, "same", "same")
    expect(await integrationEvidenceFor(mission, async () => "same")).toEqual(check.evidence)
    expect(await integrationEvidenceFor(mission, async () => "changed")).toBeUndefined()
    expect(
      await integrationEvidenceFor(mission, async () => {
        throw new Error("no git metadata")
      }),
    ).toBeUndefined()
  })

  it("leads a combined result with the failing part and keeps the end of a long operator output", () => {
    const contractPart = { ok: true, output: "cargo test --workspace\nPASS" }
    const operator = { ok: false, output: `make gate\nFAIL${"x".repeat(9_000)}harness: layer violation` }
    const combined = combinedIntegrationResult(contractPart, operator)
    expect(combined.ok).toBe(false)
    expect(combined.output.startsWith("make gate")).toBe(true)
    expect(combined.output).toContain("harness: layer violation")
    expect(combined.output.endsWith("cargo test --workspace\nPASS")).toBe(true)
    expect(combined.output.length).toBeLessThanOrEqual(8_000)
    expect(combinedIntegrationResult(contractPart, { ok: true, output: "make gate\nPASS" })).toEqual({
      ok: true,
      output: "cargo test --workspace\nPASS\n\nmake gate\nPASS",
    })
  })

  it("accepts a workspace test run that reports every failing binary", () => {
    expect(safeVerificationCommand("cargo", ["test", "--workspace", "--no-fail-fast"])).toBe(true)
    expect(safeVerificationCommand("cargo", ["test", "--workspace", "--no-run"])).toBe(false)
  })
})

describe("integration check wave context", () => {
  it("passes changedFiles, taskIds and openCodeTasks when every target has an AV changeSet", async () => {
    const { mission, ports } = codeFixture()
    mission.plan = {
      tasks: [
        {
          id: "task-1",
          title: "first",
          personaId: "worker",
          instructions: "first",
          acceptance: ["done"],
          dependencies: [],
        },
        {
          id: "task-2",
          title: "second",
          personaId: "worker",
          instructions: "second",
          acceptance: ["done"],
          dependencies: ["task-1"],
        },
      ],
    }
    const sha = "a".repeat(64)
    const tree = "b".repeat(40)
    mission.tasks = [
      {
        id: "task-1",
        reviewerId: "reviewer",
        status: "reviewing",
        attempts: 1,
        output: "done",
        changeSet: {
          version: 1,
          inputTree: tree,
          deliveryTree: tree,
          files: [
            { path: "crates/arc-cli/src/lib.rs", status: "modified", size: 10, sha256: sha },
            { path: "crates/arc-core/src/lib.rs", status: "modified", size: 12, sha256: sha },
          ],
          diff: "",
          diffTruncated: false,
        },
      },
      { id: "task-2", reviewerId: "reviewer", status: "pending", attempts: 0 },
    ]
    const firstTask = mission.tasks[0]
    if (!firstTask) throw new Error("Expected task-1")
    const check = vi.fn(async () => ({ ok: true, output: "ok" }))
    ports.integrationCheck = check
    await recordIntegrationCheck(mission, ports, [firstTask], async () => {})
    expect(check).toHaveBeenCalledWith(mission, {
      taskIds: ["task-1"],
      changedFiles: ["crates/arc-cli/src/lib.rs", "crates/arc-core/src/lib.rs"],
      openCodeTasks: 1,
    })

    // Final code wave: task-1 completed, task-2 has no changeSet (direct worktree edit) -> omit changedFiles
    firstTask.status = "completed"
    const secondTask = {
      id: "task-2",
      reviewerId: "reviewer",
      status: "reviewing" as const,
      attempts: 1,
      output: "direct",
    }
    mission.tasks[1] = secondTask
    await recordIntegrationCheck(mission, ports, [secondTask], async () => {})
    expect(check).toHaveBeenLastCalledWith(mission, {
      taskIds: ["task-2"],
      openCodeTasks: 0,
    })
  })

  it("writes changed files to .agent-valley/integration-checks and exposes context env", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "av-integration-ctx-"))
    roots.push(rootDir)
    const env = await integrationCheckContextEnv(
      rootDir,
      {
        taskIds: ["task-1", "task-2"],
        changedFiles: ["crates/arc-core/src/lib.rs", "crates/arc-cli/src/main.rs"],
        openCodeTasks: 2,
      },
      new Date("2026-11-21T00:00:00.000Z"),
    )
    expect(env[INTEGRATION_TASK_IDS_ENV]).toBe("task-1,task-2")
    expect(env[INTEGRATION_OPEN_TASKS_ENV]).toBe("2")
    const filePath = env[INTEGRATION_CHANGED_FILES_FILE_ENV]
    if (!filePath) throw new Error("Expected AV_INTEGRATION_CHANGED_FILES_FILE")
    expect(filePath).toContain(".agent-valley/integration-checks/2026-11-21T00-00-00-000Z.changed-files.txt")
    expect(await readFile(filePath, "utf8")).toBe("crates/arc-core/src/lib.rs\ncrates/arc-cli/src/main.rs\n")

    const fallback = await integrationCheckContextEnv(rootDir, { taskIds: ["task-3"], openCodeTasks: 0 })
    expect(fallback[INTEGRATION_CHANGED_FILES_FILE_ENV]).toBeUndefined()
    expect(fallback[INTEGRATION_OPEN_TASKS_ENV]).toBe("0")
  })

  it("captures direct-in-workspace changeSet and forwards changedFiles to recordIntegrationCheck when openCodeTasks > 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-direct-integration-"))
    roots.push(root)
    const { runCommand } = await import("../workspace/worktree-lifecycle")
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "AV Test"],
      ["config", "user.email", "av@example.invalid"],
    ]) {
      await runCommand("git", args, { cwd: root })
    }
    await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
    await writeFile(join(root, "onboarding.ts"), "export const onboarding = false;\n")
    await runCommand("git", ["add", "."], { cwd: root })
    await runCommand("git", ["commit", "-m", "initial"], { cwd: root })

    const { mission, ports, runAgent } = codeFixture()
    mission.workspace.path = root
    const { captureWorkspaceTree, collectDirectChangeSet } = await import("./parallel-workspace")
    ports.captureWorkspaceTree = captureWorkspaceTree
    ports.collectDirectChangeSet = collectDirectChangeSet

    const tasks = [
      {
        id: "task-1",
        title: "first",
        personaId: "worker",
        instructions: "first",
        acceptance: ["done"],
        dependencies: [],
      },
      {
        id: "task-2",
        title: "second",
        personaId: "worker",
        instructions: "second",
        acceptance: ["done"],
        dependencies: ["task-1"],
      },
    ]

    const check = vi.fn(async (_m, context?: IntegrationCheckContext) => {
      if (context?.changedFiles) {
        const env = await integrationCheckContextEnv(root, context)
        expect(env[INTEGRATION_CHANGED_FILES_FILE_ENV]).toBeDefined()
      }
      return { ok: true, output: "ok" }
    })
    ports.integrationCheck = check

    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "work") {
        if (args[4]?.taskId === "task-1") {
          await writeFile(join(root, "onboarding.ts"), "export const onboarding = true;\n")
        } else if (args[4]?.taskId === "task-2") {
          await writeFile(join(root, "feature.ts"), "export const feature = true;\n")
        }
      }
      return (await original?.(...args)) ?? passed
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")

    // Task 1 check: openCodeTasks is 1, changedFiles is ["onboarding.ts"]
    expect(check).toHaveBeenCalledWith(mission, {
      taskIds: ["task-1"],
      changedFiles: ["onboarding.ts"],
      openCodeTasks: 1,
    })
    const task1State = mission.tasks.find((s) => s.id === "task-1")
    expect(task1State?.changeSet?.files).toEqual([
      expect.objectContaining({ path: "onboarding.ts", status: "modified" }),
    ])

    // Task 2 check: openCodeTasks is 0, changedFiles is ["feature.ts"]
    expect(check).toHaveBeenLastCalledWith(mission, {
      taskIds: ["task-2"],
      changedFiles: ["feature.ts"],
      openCodeTasks: 0,
    })
    const task2State = mission.tasks.find((s) => s.id === "task-2")
    expect(task2State?.changeSet?.files).toEqual([expect.objectContaining({ path: "feature.ts", status: "added" })])
  })

  it("omits changedFiles on fallback when changeSet capture is unavailable or fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-direct-integration-fallback-"))
    roots.push(root)
    const { runCommand } = await import("../workspace/worktree-lifecycle")
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "AV Test"],
      ["config", "user.email", "av@example.invalid"],
    ]) {
      await runCommand("git", args, { cwd: root })
    }
    await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
    await writeFile(join(root, "onboarding.ts"), "export const onboarding = false;\n")
    await runCommand("git", ["add", "."], { cwd: root })
    await runCommand("git", ["commit", "-m", "initial"], { cwd: root })

    const { mission, ports, runAgent } = codeFixture()
    mission.workspace.path = root
    // ChangeSet capture unavailable
    delete ports.captureWorkspaceTree
    delete ports.collectDirectChangeSet

    const tasks = [
      {
        id: "task-1",
        title: "first",
        personaId: "worker",
        instructions: "first",
        acceptance: ["done"],
        dependencies: [],
      },
    ]

    const check = vi.fn(async () => ({ ok: true, output: "ok" }))
    ports.integrationCheck = check

    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "work") {
        await writeFile(join(root, "onboarding.ts"), "export const onboarding = true;\n")
      }
      return (await original?.(...args)) ?? passed
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(check).toHaveBeenCalledWith(mission, {
      taskIds: ["task-1"],
      openCodeTasks: 0,
    })
    const taskState = mission.tasks.find((s) => s.id === "task-1")
    expect(taskState?.changeSet).toBeUndefined()
  })

  it("updates changeSet cleanly on task repair retry (attempt 2+)", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-direct-integration-retry-"))
    roots.push(root)
    const { runCommand } = await import("../workspace/worktree-lifecycle")
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "AV Test"],
      ["config", "user.email", "av@example.invalid"],
    ]) {
      await runCommand("git", args, { cwd: root })
    }
    await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
    await writeFile(join(root, "onboarding.ts"), "export const onboarding = false;\n")
    await runCommand("git", ["add", "."], { cwd: root })
    await runCommand("git", ["commit", "-m", "initial"], { cwd: root })

    const { mission, ports, runAgent } = codeFixture()
    mission.workspace.path = root
    const { captureWorkspaceTree, collectDirectChangeSet } = await import("./parallel-workspace")
    ports.captureWorkspaceTree = captureWorkspaceTree
    ports.collectDirectChangeSet = collectDirectChangeSet

    mission.maxRepairs = 1
    const tasks = [
      {
        id: "task-1",
        title: "first",
        personaId: "worker",
        instructions: "first",
        acceptance: ["done"],
        dependencies: [],
      },
    ]

    const check = vi.fn(async () => ({ ok: true, output: "ok" }))
    ports.integrationCheck = check

    const original = runAgent.getMockImplementation()
    let attempt = 0
    let reviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "work") {
        attempt += 1
        if (attempt === 1) {
          await writeFile(join(root, "onboarding.ts"), "export const onboarding = 1;\n")
        } else {
          await writeFile(join(root, "repair.ts"), "export const repair = 1;\n")
        }
      }
      if (args[3] === "review") {
        reviews += 1
        return reviews === 1 ? rejected : passed
      }
      return (await original?.(...args)) ?? passed
    })

    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")

    // Attempt 1 changed onboarding.ts
    expect(check).toHaveBeenNthCalledWith(1, mission, {
      taskIds: ["task-1"],
      changedFiles: ["onboarding.ts"],
      openCodeTasks: 0,
    })
    // Attempt 2 (repair) added repair.ts
    expect(check).toHaveBeenNthCalledWith(2, mission, {
      taskIds: ["task-1"],
      changedFiles: ["repair.ts"],
      openCodeTasks: 0,
    })
    const taskState = mission.tasks.find((s) => s.id === "task-1")
    expect(taskState?.attempts).toBe(2)
    expect(taskState?.changeSet?.files).toEqual([expect.objectContaining({ path: "repair.ts", status: "added" })])
  })
})

describe("no-op wave integration check reuse", () => {
  const emptyChangeSet = {
    version: 1 as const,
    inputTree: "a".repeat(40),
    deliveryTree: "a".repeat(40),
    files: [],
    diff: "",
    diffTruncated: false,
  }

  function twoCodeTasksMission() {
    const { mission, ports } = codeFixture()
    mission.plan = {
      tasks: [
        {
          id: "task-1",
          title: "first",
          personaId: "worker",
          instructions: "first",
          acceptance: ["done"],
          dependencies: [],
        },
        {
          id: "task-2",
          title: "second",
          personaId: "worker",
          instructions: "second",
          acceptance: ["done"],
          dependencies: ["task-1"],
        },
      ],
    }
    mission.tasks = [
      { id: "task-1", reviewerId: "reviewer", status: "completed", attempts: 1, output: "done" },
      { id: "task-2", reviewerId: "reviewer", status: "reviewing", attempts: 1, output: "done" },
    ]
    return { mission, ports }
  }

  it("reuses a passing final-wave integration check on a subsequent no-op repair wave with identical fingerprint", async () => {
    const { mission, ports } = twoCodeTasksMission()
    const fp = "f".repeat(64)
    ports.fingerprint = vi.fn(async () => fp)
    const check = vi.fn(async () => ({ ok: true, output: "cargo test --workspace\nPASS: all 404 tests" }))
    ports.integrationCheck = check
    const history: string[] = []
    const save = async (_stage: string, message: string) => {
      history.push(message)
    }

    // 1. Final-wave integration check passes (openCodeTasks === 0)
    const task2 = mission.tasks[1]
    if (!task2) throw new Error("Expected task-2")
    await recordIntegrationCheck(mission, ports, [task2], save)
    expect(check).toHaveBeenCalledTimes(1)
    expect(mission.lastPassingIntegrationCheck).toMatchObject({
      fingerprint: fp,
      openCodeTasks: 0,
      output: "cargo test --workspace\nPASS: all 404 tests",
    })

    // Seed integrationEvidence to verify reuse preserves it untouched
    const existingEvidence = {
      fingerprint: fp,
      checkedAt: "2026-11-27T00:00:00.000Z",
      checks: [
        {
          checkSha256: "1".repeat(64),
          kind: "command" as const,
          passed: true,
          summary: "PASS",
          exitCode: 0,
          outputSha256: "2".repeat(64),
        },
      ],
    }
    mission.integrationEvidence = existingEvidence

    // 2. Final-review repair wave runs task-1 as a no-op (empty changeSet) on identical fingerprint (openCodeTasks === 0)
    task2.status = "completed"
    mission.tasks[0] = {
      id: "task-1",
      reviewerId: "reviewer",
      status: "reviewing",
      attempts: 2,
      output: "no-op repair",
      changeSet: emptyChangeSet,
    }
    await recordIntegrationCheck(mission, ports, [mission.tasks[0]], save)
    expect(check).toHaveBeenCalledTimes(1)
    expect(mission.tasks[0].integrationCheck?.ok).toBe(true)
    expect(mission.tasks[0].integrationCheck?.output).toContain(
      "Reused passing integration check for unchanged workspace.",
    )
    expect(mission.tasks[0].integrationCheck?.output).toContain("PASS: all 404 tests")
    expect(mission.integrationEvidence).toBe(existingEvidence)
    expect(history.at(-1)).toContain("Reused passing integration check on unchanged workspace before review of task-1.")

    // 3. Also reuses when a prior final-wave check (openCodeTasks === 0) precedes a mid-cycle no-op wave (openCodeTasks === 1)
    task2.status = "pending"
    mission.tasks[0] = { ...mission.tasks[0], integrationCheck: undefined }
    await recordIntegrationCheck(mission, ports, [mission.tasks[0]], save)
    expect(check).toHaveBeenCalledTimes(1)
    expect(mission.tasks[0]?.integrationCheck?.ok).toBe(true)
  })

  it("does NOT reuse a mid-cycle check (openCodeTasks > 0) for a final-wave no-op task (openCodeTasks === 0)", async () => {
    const { mission, ports } = twoCodeTasksMission()
    const fp = "e".repeat(64)
    ports.fingerprint = vi.fn(async () => fp)
    const check = vi.fn(async () => ({ ok: true, output: "scoped pass" }))
    ports.integrationCheck = check

    // Mid-cycle wave: task-1 reviewing while task-2 is pending -> openCodeTasks === 1
    mission.tasks[0] = { id: "task-1", reviewerId: "reviewer", status: "reviewing", attempts: 1, output: "mid" }
    mission.tasks[1] = { id: "task-2", reviewerId: "reviewer", status: "pending", attempts: 0 }
    await recordIntegrationCheck(mission, ports, [mission.tasks[0]], async () => {})
    expect(check).toHaveBeenCalledTimes(1)
    expect(mission.lastPassingIntegrationCheck?.openCodeTasks).toBe(1)

    // Final wave: task-1 completed, task-2 no-op -> openCodeTasks === 0 -> MUST run full check!
    mission.tasks[0].status = "completed"
    mission.tasks[1] = {
      id: "task-2",
      reviewerId: "reviewer",
      status: "reviewing",
      attempts: 1,
      output: "no-op final",
      changeSet: emptyChangeSet,
    }
    await recordIntegrationCheck(mission, ports, [mission.tasks[1]], async () => {})
    expect(check).toHaveBeenCalledTimes(2)
    expect(mission.lastPassingIntegrationCheck?.openCodeTasks).toBe(0)
  })

  it("does NOT reuse when workspace fingerprint changed or changeSet is missing", async () => {
    const { mission, ports } = twoCodeTasksMission()
    let currentFp = "1".repeat(64)
    ports.fingerprint = vi.fn(async () => currentFp)
    const check = vi.fn(async () => ({ ok: true, output: "pass" }))
    ports.integrationCheck = check

    const task2 = mission.tasks[1]
    if (!task2) throw new Error("Expected task-2")
    await recordIntegrationCheck(mission, ports, [task2], async () => {})
    expect(check).toHaveBeenCalledTimes(1)

    // Fingerprint drifted -> must re-run even with empty changeSet
    currentFp = "2".repeat(64)
    delete task2.integrationCheck
    task2.changeSet = emptyChangeSet
    await recordIntegrationCheck(mission, ports, [task2], async () => {})
    expect(check).toHaveBeenCalledTimes(2)

    // Missing changeSet (changedFiles === undefined) -> must re-run even on identical fingerprint
    delete task2.integrationCheck
    delete task2.changeSet
    await recordIntegrationCheck(mission, ports, [task2], async () => {})
    expect(check).toHaveBeenCalledTimes(3)
  })

  it("clears lastPassingIntegrationCheck on failure and never reuses a failed check", async () => {
    const { mission, ports } = twoCodeTasksMission()
    const fp = "3".repeat(64)
    ports.fingerprint = vi.fn(async () => fp)
    const check = vi
      .fn<NonNullable<typeof ports.integrationCheck>>()
      .mockResolvedValueOnce({ ok: true, output: "initial pass" })
      .mockResolvedValueOnce({ ok: false, output: "regression failed" })
      .mockResolvedValueOnce({ ok: true, output: "recovered pass" })
    ports.integrationCheck = check

    const task2 = mission.tasks[1]
    if (!task2) throw new Error("Expected task-2")
    await recordIntegrationCheck(mission, ports, [task2], async () => {})
    expect(mission.lastPassingIntegrationCheck?.fingerprint).toBe(fp)

    // Subsequent check fails (no changeSet so it runs) -> clears lastPassingIntegrationCheck
    mission.tasks[1] = { ...task2, integrationCheck: undefined }
    await recordIntegrationCheck(mission, ports, [mission.tasks[1]], async () => {})
    expect(mission.tasks[1]?.integrationCheck?.ok).toBe(false)
    expect(mission.lastPassingIntegrationCheck).toBeUndefined()

    // Next no-op wave must NOT reuse because lastPassingIntegrationCheck was cleared
    mission.tasks[1] = { ...mission.tasks[1], integrationCheck: undefined, changeSet: emptyChangeSet }
    await recordIntegrationCheck(mission, ports, [mission.tasks[1]], async () => {})
    expect(check).toHaveBeenCalledTimes(3)
    expect(mission.lastPassingIntegrationCheck?.fingerprint).toBe(fp)
  })

  it("validates lastPassingIntegrationCheck in validateMission and rejects invalid shapes", () => {
    const { mission } = codeFixture()
    mission.lastPassingIntegrationCheck = {
      fingerprint: "a".repeat(64),
      openCodeTasks: 0,
      at: "2026-11-27T12:00:00.000Z",
      output: "PASS",
    }
    expect(() => validateMission(structuredClone(mission))).not.toThrow()

    const badOpenCount = structuredClone(mission)
    if (badOpenCount.lastPassingIntegrationCheck) badOpenCount.lastPassingIntegrationCheck.openCodeTasks = -1
    expect(() => validateMission(badOpenCount)).toThrow()

    const badTimestamp = structuredClone(mission)
    if (badTimestamp.lastPassingIntegrationCheck) badTimestamp.lastPassingIntegrationCheck.at = "not-a-date"
    expect(() => validateMission(badTimestamp)).toThrow()

    const extraField = structuredClone(mission) as unknown as Record<string, unknown>
    extraField.lastPassingIntegrationCheck = {
      fingerprint: "a".repeat(64),
      openCodeTasks: 0,
      at: "2026-11-27T12:00:00.000Z",
      output: "PASS",
      unexpected: true,
    }
    expect(() => validateMission(extraField as unknown as typeof mission)).toThrow()
  })
})
