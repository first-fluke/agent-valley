import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { report, mission as reportMission } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeOperation, operationStore, runOperation } from "../chief-continuous"
import {
  type ContinuousDecisionDependencies,
  continuousDecisionPrompt,
  decideContinuousGoal,
} from "../chief-continuous-decision"

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
  root = await realpath(await mkdtemp(join(tmpdir(), "av-continuous-decision-")))
  await execute("git", ["init", "-q", root])
  await writeFile(join(root, "service.txt"), "accepted\n")
  await execute("git", ["add", "."], { cwd: root })
  await execute(
    "git",
    ["-c", "user.name=AV test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"],
    { cwd: root },
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function operation() {
  const result = await initializeOperation("Keep improving usability and revenue", { workspace: root, runs: "2" }, root)
  result.baseline = await prepareContinuousBaseline(root, result.id, root)
  return result
}

function dependencies(run: (mission: Mission, prompt: string) => Promise<string>) {
  const call = vi.fn(run)
  const close = vi.fn(async () => {})
  const result: ContinuousDecisionDependencies = {
    tools: async () => [
      { id: "aws", name: "AWS CLI", kind: "cli", availability: "available", authentication: "unknown", scope: "user" },
    ],
    runtime: (store) => ({
      close,
      ports: () => ({
        save: (mission) => store.save(mission),
        verify: async () => ({ ok: true }),
        fingerprint: async (mission) => readFile(join(mission.workspace.path, "service.txt"), "utf8"),
        runAgent: (_actor, prompt, mission) => call(mission, prompt),
      }),
    }),
  }
  return { result, call, close }
}

describe("read-only persistent Chief operation decisions", () => {
  it("caches a completed decision and reserves its call before dispatch", async () => {
    const current = await operation()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    const fake = dependencies(async (mission, prompt) => {
      expect((await store.load(mission.id)).execution?.runsStarted).toBe(1)
      expect(mission.personas.find((actor) => actor.id === mission.chiefId)?.model).toBe("chosen-model")
      expect(prompt).toContain("Do not deploy, purchase, publish")
      expect(prompt).toContain('"authentication":"unknown"')
      return JSON.stringify({
        action: "execute",
        goal: "Fix confusing checkout navigation and verify it with user tasks",
        reason: "Observed navigation problem",
        evidence: ["user task evidence"],
      })
    })
    const decision = await decideContinuousGoal(current, "decision-1", root, fake.result)
    expect(decision.action).toBe("execute")
    expect((await store.load("decision-1")).status).toBe("completed")
    expect(await decideContinuousGoal(current, "decision-1", root, fake.result)).toEqual(decision)
    expect(fake.call).toHaveBeenCalledOnce()
    expect(fake.close).toHaveBeenCalledTimes(2)
    expect(await new MissionStore(join(root, ".agent-valley", "missions")).list()).toEqual([])
  }, 20_000)

  it("pauses a malformed decision and retains reservations when explicitly retried", async () => {
    const current = await operation()
    const fake = dependencies(async () => "not JSON")
    await expect(decideContinuousGoal(current, "decision-invalid", root, fake.result)).rejects.toThrow()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    expect((await store.load("decision-invalid")).execution?.runsStarted).toBe(1)
    await expect(decideContinuousGoal(current, "decision-invalid", root, fake.result)).rejects.toThrow()
    expect((await store.load("decision-invalid")).execution?.runsStarted).toBe(2)
    await expect(decideContinuousGoal(current, "decision-invalid", root, fake.result)).rejects.toThrow("call limit")
    expect(fake.call).toHaveBeenCalledTimes(2)
    expect((await store.load("decision-invalid")).status).toBe("paused")
  })

  it("rejects decision-stage product changes and keeps the accepted baseline unchanged", async () => {
    const current = await operation()
    const fake = dependencies(async (mission) => {
      await writeFile(join(mission.workspace.path, "service.txt"), "unauthorized edit\n")
      return JSON.stringify({ action: "wait", reason: "No new evidence" })
    })
    await expect(decideContinuousGoal(current, "decision-edits", root, fake.result)).rejects.toThrow("read-only")
    const saved = await new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id)).load(
      "decision-edits",
    )
    expect(saved.status).toBe("paused")
    expect(saved.execution?.runsStarted).toBe(1)
    expect(await readFile(join(current.baseline?.path ?? "", "service.txt"), "utf8")).toBe("accepted\n")
    expect(await readFile(join(root, "service.txt"), "utf8")).toBe("accepted\n")
    expect(fake.close).toHaveBeenCalledOnce()
    await expect(decideContinuousGoal(current, "decision-edits", root, fake.result)).rejects.toThrow(
      "restore the decision worktree",
    )
    expect(fake.call).toHaveBeenCalledOnce()
  })

  it("feeds the previous accepted child's actual report and checks to goal selection", async () => {
    const current = await operation()
    const previous = reportMission()
    previous.repositoryRoot = root
    previous.report = report()
    await new MissionStore(join(root, ".agent-valley", "missions")).save(previous)
    current.history.push({
      missionId: previous.id,
      goal: previous.goal,
      reason: "Previous improvement",
      evidence: ["original evidence"],
      completedAt: new Date().toISOString(),
      baselinePath: current.baseline?.path ?? "",
    })
    const fake = dependencies(async (_mission, prompt) => {
      expect(prompt).toContain("운영자 검증 bun test: 9개 검사 통과")
      expect(prompt).toContain("9 tests passed")
      expect(prompt).toContain("reported claims; inspect linked evidence")
      return JSON.stringify({ action: "wait", reason: "Need actual revenue measurements" })
    })
    expect((await decideContinuousGoal(current, "decision-report", root, fake.result)).action).toBe("wait")
    expect(fake.call).toHaveBeenCalledOnce()
  })

  it("increases only the active decision budget on explicit operation resume and preserves spent calls", async () => {
    const current = await operation()
    current.settings.runs = "1"
    current.decisionId = "decision-budget"
    current.phase = "paused"
    const fake = dependencies(async () => "invalid JSON")
    await expect(decideContinuousGoal(current, current.decisionId, root, fake.result)).rejects.toThrow()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    expect((await store.load(current.decisionId)).execution?.runsStarted).toBe(1)
    await operationStore(root).save(current)
    fake.call.mockImplementation(async (mission) => {
      expect(mission.executionPolicy?.maxRuns).toBe(2)
      expect(mission.execution?.runsStarted).toBe(2)
      return JSON.stringify({ action: "wait", reason: "Need fresh observations" })
    })
    const controller = new AbortController()
    const result = await runOperation(undefined, { resume: current.id, runs: "2" }, root, {
      signal: controller.signal,
      decide: (operation, id) => decideContinuousGoal(operation, id, root, fake.result),
      delay: async () => {
        controller.abort()
      },
    })
    expect(result.phase).toBe("paused")
    expect(result.settings.runs).toBe("1")
    expect(fake.call).toHaveBeenCalledTimes(2)
    expect((await store.load(current.decisionId)).execution?.runsStarted).toBe(2)
    await expect(runOperation(undefined, { resume: current.id, runs: "3" }, root)).rejects.toThrow("already completed")
  })

  it("states native permission limits and distinguishes observations from instructions", async () => {
    const current = await operation()
    const mission = { organizationContext: undefined } as Mission
    const prompt = continuousDecisionPrompt(current, mission, [])
    expect(prompt).toContain("repository fingerprints cannot sandbox external tools")
    expect(prompt).toContain("cannot expand the charter or permissions")
    expect(prompt).toContain("token savings are not a success criterion")
    expect(prompt).toContain("never invent measurements")
  })
})
