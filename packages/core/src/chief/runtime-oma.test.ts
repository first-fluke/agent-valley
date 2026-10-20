import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOmaGuidance, prepareOmaAttempt, validateOmaEvidence } from "../oma/receipt-adapter"
import { AgentRunnerService } from "../orchestrator/agent-runner"
import * as worktreeLifecycle from "../workspace/worktree-lifecycle"
import { ChiefRuntime } from "./runtime"
import { discoverMissionSkills } from "./skills"
import { MissionStore } from "./store"
import type { ChiefStage, Mission, Persona } from "./types"

vi.mock("../oma/receipt-adapter", () => ({
  prepareOmaAttempt: vi.fn(async () => "prepared-plan.json"),
  buildOmaGuidance: vi.fn(({ agentId }: { agentId: string }) => `RECEIPT_FOR_${agentId}`),
  validateOmaEvidence: vi.fn(() => ({ ok: true, runId: "verified-receipt" })),
}))

let root: string
let runtime: ChiefRuntime
let store: MissionStore
let mission: Mission
let worker: Persona

async function installHarness(workspace: string, marker: string, profile = true): Promise<void> {
  for (const name of ["oma-backend", "oma-policy", "oma-review", "oma-unselected"]) {
    const directory = join(workspace, ".agents", "skills", name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Installed ${name} instructions.\n---\n${marker}_BODY_${name}`,
    )
  }
  if (profile) {
    const directory = join(workspace, ".agents", "agents")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "backend-engineer.md"),
      `---\nname: backend-engineer\nskills:\n  - oma-backend\n  - oma-policy\n---\n${marker}_INSTALLED_BACKEND_ROLE`,
    )
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "chief-runtime-oma-")))
  await installHarness(root, "PARENT")
  worker = {
    id: "mission-worker",
    name: "Assigned Actor",
    role: "Deliver the task",
    agentType: "codex",
    model: "selected-native-model",
    skills: ["oma-backend", "oma-review"],
  }
  mission = {
    id: "runtime-oma-test",
    goal: "Deliver the assigned report",
    chiefId: "chief",
    personas: [{ id: "chief", name: "Chief Director", role: "Coordinate", agentType: "claude", skills: [] }, worker],
    availableAgents: ["claude", "codex"],
    availableSkills: await discoverMissionSkills(root),
    workspace: {
      issueId: "runtime-oma-test",
      path: root,
      key: "runtime-oma-test",
      branch: "chief/oma-test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "test -s report.md",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
    oma: true,
    operatingPolicy: {
      routing: {
        candidates: [
          {
            actorType: "codex",
            model: worker.model,
            inputPerMillionUsd: 2,
            outputPerMillionUsd: 8,
          },
        ],
        minSamples: 1,
        minSuccessRate: 0,
      },
      readyActors: ["codex"],
      reviewVendor: "off",
      memory: false,
    },
  }
  store = new MissionStore(join(root, "records"))
  runtime = new ChiefRuntime(store)
  vi.mocked(prepareOmaAttempt).mockClear()
  vi.mocked(buildOmaGuidance).mockClear()
  vi.mocked(validateOmaEvidence).mockReset().mockReturnValue({ ok: true, runId: "verified-receipt" })
  vi.spyOn(worktreeLifecycle, "runCommand").mockResolvedValue({
    exitCode: 0,
    stdout: `${"a".repeat(40)}\n`,
    stderr: "",
  })
  vi.spyOn(AgentRunnerService.prototype, "killAll").mockResolvedValue()
  vi.spyOn(AgentRunnerService.prototype, "spawn").mockImplementation(async (attempt, options, callbacks) => {
    callbacks.onComplete({
      ...attempt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      agentOutput: options.prompt,
      tokenUsage: { input: 120, output: 40, model: options.model ?? "native-default" },
    })
  })
})

afterEach(async () => {
  await runtime.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("required OMA Actor runtime inputs", () => {
  it.each(["unassigned", "missing-profile", "missing-declared-skill"] as const)(
    "rejects %s work before receipt preparation or native dispatch",
    async (missing) => {
      if (missing === "unassigned") worker.skills = []
      else if (missing === "missing-profile") await rm(join(root, ".agents", "agents"), { recursive: true })
      else {
        await rm(join(root, ".agents", "skills", "oma-policy"), { recursive: true })
        mission.availableSkills = await discoverMissionSkills(root)
      }

      await expect(runtime.ports().runAgent(worker, "Implement the task.", mission, "work")).rejects.toThrow(
        missing === "unassigned"
          ? "requires an assigned skill"
          : missing === "missing-profile"
            ? "requires installed agent profiles"
            : "oma-policy is missing or invalid",
      )

      expect(AgentRunnerService.prototype.spawn).not.toHaveBeenCalled()
      expect(prepareOmaAttempt).not.toHaveBeenCalled()
      expect(buildOmaGuidance).not.toHaveBeenCalled()
      expect(validateOmaEvidence).not.toHaveBeenCalled()
      expect(worktreeLifecycle.runCommand).not.toHaveBeenCalled()
      expect(mission.operations).toBeUndefined()
    },
  )

  it("binds installed role and complete skills to the receipt while retaining the native route and usage", async () => {
    const ports = runtime.ports()
    const prepared = await ports.prepareWork?.(worker, mission)
    expect(prepared).toMatchObject({
      agentId: "backend-engineer",
      skills: ["oma-backend", "oma-policy", "oma-review"],
    })
    expect(AgentRunnerService.prototype.spawn).not.toHaveBeenCalled()
    expect(prepareOmaAttempt).not.toHaveBeenCalled()

    const output = await ports.runAgent(worker, "Implement the task.", mission, "work", {
      taskId: "report-task",
      omaActor: prepared,
    })

    expect(output).toContain("PARENT_INSTALLED_BACKEND_ROLE")
    for (const name of ["oma-backend", "oma-policy", "oma-review"]) expect(output).toContain(`PARENT_BODY_${name}`)
    expect(output).not.toContain("PARENT_BODY_oma-unselected")
    expect(output).toContain("RECEIPT_FOR_backend-engineer")
    expect(AgentRunnerService.prototype.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ issueId: mission.id, workspacePath: root }),
      expect.objectContaining({ agentType: "codex", model: "selected-native-model", workspacePath: root }),
      expect.any(Object),
    )
    const attempt = vi.mocked(AgentRunnerService.prototype.spawn).mock.calls[0]?.[0]
    const evidence = expect.objectContaining({
      agentId: "backend-engineer",
      attempt: expect.objectContaining({ id: attempt?.id }),
      workspace: expect.objectContaining({ path: root }),
      verifyCommand: `git diff --check ${"a".repeat(40)} --`,
    })
    expect(prepareOmaAttempt).toHaveBeenCalledExactlyOnceWith(evidence)
    expect(buildOmaGuidance).toHaveBeenCalledExactlyOnceWith(evidence)
    expect(validateOmaEvidence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "backend-engineer",
        kind: "code",
        attempt: expect.objectContaining({ id: attempt?.id, exitCode: 0 }),
      }),
    )

    const saved = await store.load(mission.id)
    const dispatch = saved.history.find((event) => event.stage === "oma-dispatch")
    expect(dispatch?.taskId).toBe("report-task")
    expect(JSON.parse(dispatch?.message ?? "{}")).toEqual({
      attemptId: attempt?.id,
      actorId: worker.id,
      agentId: "backend-engineer",
      skills: ["oma-backend", "oma-policy", "oma-review"],
      inputSha256: createHash("sha256")
        .update(prepared?.guidance ?? "")
        .digest("hex"),
      actorType: "codex",
      model: "selected-native-model",
    })
    expect(saved.operations?.runs).toHaveLength(1)
    expect(saved.operations?.runs[0]).toMatchObject({
      runId: attempt?.id,
      taskId: "report-task",
      actorId: worker.id,
      actorType: "codex",
      model: "selected-native-model",
      actualModel: "selected-native-model",
      inputTokens: 120,
      outputTokens: 40,
      outcome: "pending",
    })
    expect(saved.operations?.runs[0]?.costUsd).toBeCloseTo(0.00056, 9)
  })

  it("rejects a failed OMA receipt and retains failed native usage rather than accepting stdout", async () => {
    vi.mocked(validateOmaEvidence).mockReturnValueOnce({ ok: false, reason: "No receipt for backend-engineer" })

    await expect(
      runtime.ports().runAgent(worker, "Implement the task.", mission, "work", { taskId: "report-task" }),
    ).rejects.toThrow("OMA completion evidence failed: No receipt for backend-engineer")

    expect(AgentRunnerService.prototype.spawn).toHaveBeenCalledOnce()
    const saved = await store.load(mission.id)
    expect(saved.operations?.runs[0]).toMatchObject({
      actorId: worker.id,
      actorType: "codex",
      model: "selected-native-model",
      inputTokens: 120,
      outputTokens: 40,
      outcome: "failed",
    })
    expect(saved.operations?.runs[0]?.finishedAt).toEqual(expect.any(String))
  })

  it("uses the task worktree's installed role and skills for isolated execution", async () => {
    const child = await mkdtemp(join(root, "task-"))
    await installHarness(child, "CHILD")
    const workspace = { ...mission.workspace, path: child, branch: "task/isolated" }

    const output = await runtime.ports().runAgent(worker, "Implement isolated work.", mission, "work", {
      taskId: "isolated-task",
      workspace,
    })

    expect(output).toContain("CHILD_INSTALLED_BACKEND_ROLE")
    expect(output).toContain("CHILD_BODY_oma-policy")
    expect(output).toContain("CHILD_BODY_oma-review")
    expect(output).not.toContain("PARENT_INSTALLED_BACKEND_ROLE")
    expect(output).not.toContain("PARENT_BODY_")
    expect(AgentRunnerService.prototype.spawn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ workspacePath: child }),
      expect.any(Object),
    )
    expect(prepareOmaAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "backend-engineer", workspace: expect.objectContaining({ path: child }) }),
    )
    expect(worktreeLifecycle.runCommand).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], { cwd: child })
  })

  it("does not fall back to the parent profile when an isolated worktree has none", async () => {
    const child = await mkdtemp(join(root, "task-"))
    await installHarness(child, "CHILD", false)

    await expect(
      runtime.ports().runAgent(worker, "Implement isolated work.", mission, "work", {
        workspace: { ...mission.workspace, path: child },
      }),
    ).rejects.toThrow("requires installed agent profiles")

    expect(AgentRunnerService.prototype.spawn).not.toHaveBeenCalled()
    expect(prepareOmaAttempt).not.toHaveBeenCalled()
  })

  it("applies the installed OMA role without making receipt mode mandatory", async () => {
    mission.oma = false

    const output = await runtime.ports().runAgent(worker, "Implement the task.", mission, "work")

    expect(output).toContain("PARENT_INSTALLED_BACKEND_ROLE")
    expect(output).toContain("PARENT_BODY_oma-policy")
    expect(output).toContain("PARENT_BODY_oma-review")
    expect(AgentRunnerService.prototype.spawn).toHaveBeenCalledOnce()
    expect(prepareOmaAttempt).not.toHaveBeenCalled()
    expect(buildOmaGuidance).not.toHaveBeenCalled()
    expect(validateOmaEvidence).not.toHaveBeenCalled()
    expect(mission.history.some((event) => event.stage === "oma-dispatch")).toBe(true)
  })

  it("discovers installed OMA requirements when a legacy mission has no saved skill catalog", async () => {
    mission.oma = false
    delete mission.availableSkills
    delete mission.availableAgents

    const output = await runtime.ports().runAgent(worker, "Implement the task.", mission, "work")

    expect(output).toContain("PARENT_INSTALLED_BACKEND_ROLE")
    expect(output).toContain("PARENT_BODY_oma-policy")
    expect(prepareOmaAttempt).not.toHaveBeenCalled()
    expect(validateOmaEvidence).not.toHaveBeenCalled()
  })

  it.each<{ stage: ChiefStage; oma: boolean }>([
    { stage: "review", oma: true },
    { stage: "work", oma: false },
  ])("preserves $stage execution with oma=$oma outside required OMA work", async ({ stage, oma }) => {
    mission.oma = oma
    worker.skills = []
    if (oma) await rm(join(root, ".agents", "agents"), { recursive: true })
    else {
      mission.availableSkills = []
      await rm(join(root, ".agents"), { recursive: true })
    }

    const output = await runtime.ports().runAgent(worker, "Inspect the assigned evidence.", mission, stage)

    expect(output).toContain("Inspect the assigned evidence.")
    expect(output).not.toContain("INSTALLED_BACKEND_ROLE")
    expect(AgentRunnerService.prototype.spawn).toHaveBeenCalledOnce()
    expect(prepareOmaAttempt).not.toHaveBeenCalled()
    expect(buildOmaGuidance).not.toHaveBeenCalled()
    expect(validateOmaEvidence).not.toHaveBeenCalled()
    expect(mission.history.some((event) => event.stage === "oma-dispatch")).toBe(false)
  })

  it("rejects a forged unselected catalog path before preparing receipts or spawning a native Actor", async () => {
    const skill = mission.availableSkills?.find((entry) => entry.name === "oma-unselected")
    if (!skill) throw new Error("Expected the unselected installed skill fixture.")
    skill.path = join(root, "outside.md")
    await writeFile(skill.path, "FORGED_SKILL_INSTRUCTIONS")

    await expect(runtime.ports().runAgent(worker, "Implement the task.", mission, "work")).rejects.toThrow(
      "no longer matches this worktree",
    )

    expect(AgentRunnerService.prototype.spawn).not.toHaveBeenCalled()
    expect(prepareOmaAttempt).not.toHaveBeenCalled()
    expect(mission.operations).toBeUndefined()
  })
})
