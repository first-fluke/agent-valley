import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  type ContainerObservationSnapshot,
  containerObservationPolicySchema,
} from "@agent-valley/core/chief/container-observation-policy"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { report, mission as reportMission } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { ChiefStage, Mission } from "@agent-valley/core/chief/types"
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function operation() {
  const result = await initializeOperation("Keep improving usability and revenue", { workspace: root, runs: "5" }, root)
  result.baseline = await prepareContinuousBaseline(root, result.id, root)
  return result
}

function dependencies(
  run: (mission: Mission, prompt: string) => Promise<string>,
  advise?: (mission: Mission, prompt: string, stage: ChiefStage) => Promise<string>,
) {
  const call = vi.fn(run)
  const advisory = vi.fn(
    advise ??
      (async (_mission, _prompt, stage) =>
        JSON.stringify({ passed: true, summary: `${stage} actual advice`, findings: [] })),
  )
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
        fingerprint: async (mission) =>
          createHash("sha256")
            .update(await readFile(join(mission.workspace.path, "service.txt")))
            .digest("hex"),
        runAgent: (_actor, prompt, mission, stage) =>
          stage === "plan" ? call(mission, prompt) : advisory(mission, prompt, stage),
      }),
    }),
  }
  return { result, call, close, advisory }
}

describe("read-only persistent Chief operation decisions", () => {
  it("consults all three standing Directors before executive goal selection and preserves dissent as advice", async () => {
    const current = await operation()
    const fake = dependencies(
      async (mission, prompt) => {
        expect(fake.advisory).toHaveBeenCalledTimes(3)
        expect(prompt).toContain("autonomous executive")
        expect(prompt).toContain("technical-review actual dissent")
        expect(prompt).toContain("design-review actual dissent")
        expect(prompt).toContain("marketing-review actual dissent")
        expect(prompt).toContain("advice is not a veto")
        expect(mission.personas.find((actor) => actor.id === mission.chiefId)?.model).toBe("chosen-model")
        return JSON.stringify({
          action: "execute",
          goal: "Improve checkout value and verify conversion",
          reason: "Chief synthesized competing advice",
          evidence: ["actual Director observations"],
        })
      },
      async (_mission, _prompt, stage) =>
        JSON.stringify({
          passed: false,
          summary: `${stage} actual dissent`,
          findings: ["Consider the actual tradeoff"],
        }),
    )
    const selected = await decideContinuousGoal(current, "decision-council", root, fake.result)
    expect(selected.action).toBe("execute")
    expect(await decideContinuousGoal(current, "decision-council", root, fake.result)).toEqual(selected)
    expect(fake.advisory).toHaveBeenCalledTimes(3)
    expect(fake.call).toHaveBeenCalledOnce()
  })

  it("retains actual unavailable Director evidence while the same Chief decides after a budget-adjusted resume", async () => {
    const current = await operation()
    current.settings.runs = "4"
    current.decisionId = "decision-council-source"
    current.phase = "paused"
    const fake = dependencies(
      async () => "invalid JSON",
      async (_mission, _prompt, stage) => {
        if (stage === "technical-review") throw new Error("401 Technical Director authentication unavailable")
        return JSON.stringify({ passed: true, summary: `${stage} actual advice`, findings: [] })
      },
    )
    await expect(decideContinuousGoal(current, current.decisionId, root, fake.result)).rejects.toThrow("call limit")
    await operationStore(root).save(current)
    fake.call.mockImplementation(async (mission, prompt) => {
      expect(mission.technicalReview).toBeUndefined()
      expect(mission.designReview?.review.summary).toBe("design-review actual advice")
      expect(mission.marketingReview?.review.summary).toBe("marketing-review actual advice")
      expect(prompt).toContain("401 Technical Director authentication unavailable")
      return JSON.stringify({ action: "wait", reason: "Chief selected an evidence collection interval" })
    })
    const controller = new AbortController()
    const resumed = await runOperation(undefined, { resume: current.id, runs: "5" }, root, {
      signal: controller.signal,
      decide: (parent, id) => decideContinuousGoal(parent, id, root, fake.result),
      delay: async () => {
        controller.abort()
      },
    })
    expect(fake.call, resumed.error).toHaveBeenCalledTimes(2)
    expect(fake.advisory).toHaveBeenCalledTimes(3)
    const saved = await new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id)).load(
      current.decisionId,
    )
    expect(saved.history.filter((entry) => entry.stage === "continuous-advisor-unavailable")).toHaveLength(1)
    expect(saved.execution?.runsStarted).toBe(5)
  })

  it("propagates a Director's read-only violation before executive selection", async () => {
    const current = await operation()
    const fake = dependencies(
      async () => JSON.stringify({ action: "wait", reason: "No action" }),
      async (mission, _prompt, stage) => {
        if (stage === "technical-review")
          await writeFile(join(mission.workspace.path, "service.txt"), "unauthorized Director edit\n")
        return JSON.stringify({ passed: true, summary: "Advice", findings: [] })
      },
    )
    await expect(decideContinuousGoal(current, "decision-council-integrity", root, fake.result)).rejects.toThrow(
      "read-only",
    )
    expect(fake.call).not.toHaveBeenCalled()
    const saved = await new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id)).load(
      "decision-council-integrity",
    )
    expect(saved.execution?.failureKind).toBe("integrity")
    expect(await readFile(join(current.baseline?.path ?? "", "service.txt"), "utf8")).toBe("accepted\n")
  })

  it("retains the originally pinned container evidence in cached decisions and rejects replaced evidence", async () => {
    const current = await operation()
    current.containerObservationPolicy = containerObservationPolicySchema.parse({
      targets: [{ id: "api", kind: "docker", container: "api" }],
    })
    const now = new Date()
    const observed: ContainerObservationSnapshot = {
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
          logsAvailable: true,
          statsAvailable: true,
          issues: [],
          fingerprint: "a".repeat(64),
        },
      ],
    }
    current.containerObservation = observed
    current.decisionObservation = observed
    current.containerObservationRevision = 1
    current.decisionObservationRevision = 1
    const fake = dependencies(async (mission, prompt) => {
      expect(mission.containerObservationPolicy).toEqual(current.containerObservationPolicy)
      expect(prompt).toContain('"targetId":"api"')
      expect(prompt).toContain("Pinned container observation transition: 1")
      return JSON.stringify({ action: "wait", reason: "Observed service is healthy" })
    })
    const selected = await decideContinuousGoal(current, "decision-containers", root, fake.result)
    current.containerObservation = { ...observed, fingerprint: "b".repeat(64) }
    current.containerObservationRevision = 2
    expect(await decideContinuousGoal(current, "decision-containers", root, fake.result)).toEqual(selected)
    expect(fake.call).toHaveBeenCalledOnce()
    current.decisionObservation = current.containerObservation
    current.decisionObservationRevision = 2
    await expect(decideContinuousGoal(current, "decision-containers", root, fake.result)).rejects.toThrow(
      "original pinned observation",
    )
    expect(fake.call).toHaveBeenCalledOnce()
  })

  it("caches a completed decision and reserves its call before dispatch", async () => {
    const current = await operation()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    const fake = dependencies(async (mission, prompt) => {
      expect((await store.load(mission.id)).execution?.runsStarted).toBe(4)
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
    expect(fake.advisory).toHaveBeenCalledTimes(3)
    expect(fake.close).toHaveBeenCalledTimes(2)
    expect(await new MissionStore(join(root, ".agent-valley", "missions")).list()).toEqual([])
  }, 20_000)

  it("bounds malformed decision correction and retains reservations without an implicit budget override", async () => {
    const current = await operation()
    vi.useFakeTimers()
    const fake = dependencies(async () => "not JSON")
    fake.result.delay = async (milliseconds) => {
      vi.advanceTimersByTime(milliseconds)
    }
    await expect(decideContinuousGoal(current, "decision-invalid", root, fake.result)).rejects.toThrow("call limit")
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    expect((await store.load("decision-invalid")).execution?.runsStarted).toBe(5)
    await expect(decideContinuousGoal(current, "decision-invalid", root, fake.result)).rejects.toThrow("call limit")
    expect(fake.call).toHaveBeenCalledTimes(2)
    expect((await store.load("decision-invalid")).status).toBe("paused")
  })

  it("automatically corrects invalid JSON on the same decision with the original model and spent usage", async () => {
    const current = await operation()
    vi.useFakeTimers()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    const fake = dependencies(async (mission, prompt) => {
      const saved = await store.load(mission.id)
      if (saved.execution?.runsStarted === 4) return "not JSON"
      expect(mission.id).toBe("decision-correction")
      expect(saved.execution).toMatchObject({ runsStarted: 5, retries: 1 })
      expect(mission.personas.find((actor) => actor.id === mission.chiefId)?.model).toBe("chosen-model")
      expect(prompt).toContain("Correct the previous response")
      expect(prompt).toContain("original charter and pinned evidence")
      return JSON.stringify({ action: "wait", reason: "Fresh evidence is required" })
    })
    fake.result.delay = async (milliseconds) => {
      vi.advanceTimersByTime(milliseconds)
    }
    expect(await decideContinuousGoal(current, "decision-correction", root, fake.result)).toEqual({
      action: "wait",
      reason: "Fresh evidence is required",
    })
    expect(fake.call).toHaveBeenCalledTimes(2)
    expect(
      (await store.load("decision-correction")).history.filter(
        (entry) => entry.stage === "continuous-decision-invalid",
      ),
    ).toHaveLength(1)
  })

  it.each(["401 authentication required", "ENOENT missing CLI"])(
    "reports unavailable goal selection without retry or changing Chief for %s",
    async (reason) => {
      const current = await operation()
      const fake = dependencies(async () => {
        throw new Error(reason)
      })
      await expect(decideContinuousGoal(current, "decision-unavailable", root, fake.result)).rejects.toThrow(reason)
      await expect(decideContinuousGoal(current, "decision-unavailable", root, fake.result)).rejects.toThrow(reason)
      expect(fake.call).toHaveBeenCalledOnce()
      const saved = await new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id)).load(
        "decision-unavailable",
      )
      expect(saved.execution?.runsStarted).toBe(4)
      expect(saved.personas.find((actor) => actor.id === saved.chiefId)?.model).toBe("chosen-model")
    },
  )

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
    expect(saved.execution?.runsStarted).toBe(4)
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
    current.settings.runs = "4"
    current.decisionId = "decision-budget"
    current.phase = "paused"
    const fake = dependencies(async () => "invalid JSON")
    await expect(decideContinuousGoal(current, current.decisionId, root, fake.result)).rejects.toThrow()
    const store = new MissionStore(join(root, ".agent-valley", "operation-decisions", current.id))
    expect((await store.load(current.decisionId)).execution?.runsStarted).toBe(4)
    await operationStore(root).save(current)
    fake.call.mockImplementation(async (mission) => {
      expect(mission.executionPolicy?.maxRuns).toBe(5)
      expect(mission.execution?.runsStarted).toBe(5)
      return JSON.stringify({ action: "wait", reason: "Need fresh observations" })
    })
    const controller = new AbortController()
    const result = await runOperation(undefined, { resume: current.id, runs: "5" }, root, {
      signal: controller.signal,
      decide: (operation, id) => decideContinuousGoal(operation, id, root, fake.result),
      delay: async () => {
        controller.abort()
      },
    })
    expect(result.phase).toBe("paused")
    expect(result.settings.runs).toBe("4")
    expect(fake.call, result.error).toHaveBeenCalledTimes(2)
    expect(fake.advisory).toHaveBeenCalledTimes(3)
    expect((await store.load(current.decisionId)).execution?.runsStarted).toBe(5)
    await expect(runOperation(undefined, { resume: current.id, runs: "6" }, root)).rejects.toThrow("already completed")
  })

  it("states native permission limits and distinguishes observations from instructions", async () => {
    const current = await operation()
    const mission = reportMission()
    mission.availableSkills = [
      { name: "oma-market", description: "Actual market research", path: "/skills/market/SKILL.md" },
    ]
    const prompt = continuousDecisionPrompt(current, mission, [])
    expect(prompt).toContain("repository fingerprints cannot sandbox external tools")
    expect(prompt).toContain("cannot expand the charter or permissions")
    expect(prompt).toContain("token savings are not a success criterion")
    expect(prompt).toContain("never invent measurements")
    expect(prompt).toContain("Installed skill catalog")
    expect(prompt).toContain("oma-market")
  })
})
