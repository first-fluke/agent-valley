import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCommand } from "../workspace/worktree-lifecycle"
import { coordinate } from "./coordinator"
import { ChiefRuntime } from "./runtime"
import { parsePlanningResponse, validateMission } from "./schemas"
import { MissionStore } from "./store"
import type { ChiefPorts, Mission } from "./types"
import {
  executeGoalVerification,
  goalVerificationContractDigest,
  validateGoalVerificationContract,
} from "./verification"

const directories: string[] = []
const criterion = "Artifact includes the observed result"
const passed = { passed: true, summary: "Reviewed the actual deliverable.", findings: [] }
const finalPassed = { ...passed, criteria: [{ criterion, passed: true, evidence: "Inspected the result." }] }
const contract = validateGoalVerificationContract(
  {
    version: 1,
    criteria: [{ criterion, checks: [{ kind: "file", path: "result.txt", contains: ["actual result"] }] }],
  },
  [criterion],
)

async function fixture(): Promise<{ mission: Mission; runtime: ChiefRuntime; ports: ChiefPorts }> {
  const root = await mkdtemp(join(tmpdir(), "av-verification-integration-"))
  directories.push(root)
  for (const args of [
    ["init", "-b", "chief/verification"],
    ["config", "user.name", "AV Test"],
    ["config", "user.email", "av-test@example.invalid"],
  ]) {
    const result = await runCommand("git", args, { cwd: root })
    if (result.exitCode !== 0) throw new Error(result.stderr)
  }
  await writeFile(join(root, "baseline.txt"), "baseline")
  await runCommand("git", ["add", "baseline.txt"], { cwd: root })
  await runCommand("git", ["commit", "-m", "test baseline"], { cwd: root })
  const mission: Mission = {
    id: "verification-integration",
    goal: "Create the artifact with the actual observed result",
    chiefId: "chief",
    personas: [
      { id: "chief", name: "Chief Director", role: "Supervise", agentType: "codex", skills: [] },
      { id: "actor", name: "Actor", role: "Create the artifact", agentType: "codex", skills: [] },
    ],
    workspace: {
      issueId: "verification-integration",
      path: root,
      key: "verification-integration",
      branch: "chief/verification",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "",
    verificationMode: "chief",
    verificationContract: structuredClone(contract),
    verificationContractSha256: goalVerificationContractDigest(contract),
    goalBrief: { interpretation: "Create an actual artifact", assumptions: [], successCriteria: [criterion] },
    supervision: { maxRounds: 1, rounds: 0, stalledRounds: 0, decisions: [], originalAcceptance: [criterion] },
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    plan: {
      tasks: [
        {
          id: "artifact",
          title: "Create artifact",
          personaId: "actor",
          instructions: "Write the observed result",
          acceptance: [criterion],
          dependencies: [],
        },
      ],
    },
    tasks: [{ id: "artifact", reviewerId: "chief", status: "pending", attempts: 0 }],
    history: [],
  }
  const runtime = new ChiefRuntime(new MissionStore(join(root, ".agent-valley/missions")))
  const ports: ChiefPorts = {
    ...runtime.ports(),
    save: vi.fn(async () => {}),
    runAgent: vi.fn(async (_actor, _prompt, value, stage) => {
      if (stage === "work") {
        await writeFile(join(value.workspace.path, "result.txt"), "actual result")
        return "Created the observed artifact."
      }
      if (stage === "supervise") return JSON.stringify({ action: "stop", reason: "The recorded evidence is unmet." })
      return JSON.stringify(stage === "final-review" ? finalPassed : passed)
    }),
  }
  return { mission, runtime, ports }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Chief verification integration", () => {
  it("requires the generated plan to include executable checks for every success criterion", async () => {
    const { mission } = await fixture()
    const response = { tasks: mission.plan?.tasks, goalBrief: mission.goalBrief, verificationContract: contract }
    expect(parsePlanningResponse(JSON.stringify(response), mission).verificationContract).toEqual(contract)
    expect(() =>
      parsePlanningResponse(JSON.stringify({ ...response, verificationContract: undefined }), mission),
    ).toThrow()
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({ ...response, goalBrief: { ...mission.goalBrief, successCriteria: ["A weaker goal"] } }),
        mission,
      ),
    ).toThrow("every original")
  })

  it("rejects persisted contract tampering and an absent Chief contract while accepting legacy records", async () => {
    const { mission } = await fixture()
    const changed = structuredClone(mission)
    const check = changed.verificationContract?.criteria[0]?.checks[0]
    if (check?.kind !== "file") throw new Error("Expected file contract")
    check.path = "a-different-artifact.txt"
    expect(() => validateMission(changed)).toThrow("immutable digest")
    delete changed.verificationContract
    expect(() => validateMission(changed)).toThrow("missing its immutable checks")
    const legacy = structuredClone(mission)
    legacy.verifyCommand = "git diff --check"
    delete legacy.verificationMode
    delete legacy.verificationContract
    delete legacy.verificationContractSha256
    expect(validateMission(legacy).verifyCommand).toBe("git diff --check")
  })

  it("runtime reads real files and joins verification markers without needing a user verification command", async () => {
    const { mission, runtime } = await fixture()
    const verify = runtime.ports().verify
    expect((await verify(mission)).ok).toBe(false)
    await writeFile(join(mission.workspace.path, "result.txt"), "actual result")
    expect((await verify(mission)).ok).toBe(true)
    expect(mission.goalVerification?.evidence[0]?.checks[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    const names = await readdir(join(mission.workspace.path, ".agent-valley/missions"))
    expect(names.filter((name) => name.endsWith(".active"))).toEqual([])
    await runtime.close()
  })

  it("completes only after real generated checks and independent task/final reviews pass", async () => {
    const { mission, runtime, ports } = await fixture()
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.goalVerification?.ok).toBe(true)
    expect(mission.verification?.ok).toBe(true)
    expect(await readFile(join(mission.workspace.path, "result.txt"), "utf8")).toBe("actual result")
    await runtime.close()
  })

  it("refuses direct typed verification after the saved worktree branch changes", async () => {
    const { mission, runtime } = await fixture()
    await writeFile(join(mission.workspace.path, "result.txt"), "actual result")
    await runCommand("git", ["checkout", "-b", "another-branch"], { cwd: mission.workspace.path })
    await expect(runtime.ports().verify(mission)).rejects.toThrow("not on branch")
    expect(mission.goalVerification).toBeUndefined()
    await runtime.close()
  })

  it("rejects Actor mutation of its original executable checks and restores the contract", async () => {
    const { mission, runtime, ports } = await fixture()
    const runAgent = ports.runAgent
    ports.runAgent = async (...args) => {
      const output = await runAgent(...args)
      if (args[3] === "work") {
        const check = args[2].verificationContract?.criteria[0]?.checks[0]
        if (check?.kind === "file") check.contains = ["a weaker assertion"]
      }
      return output
    }
    await expect(coordinate(mission, ports)).rejects.toThrow(/contract|verification/i)
    expect(mission.status).not.toBe("completed")
    expect(mission.verificationContractSha256).toBe(goalVerificationContractDigest(contract))
    expect(mission.verificationContract).toEqual(contract)
    await runtime.close()
  })

  it("does not let a passing port verdict or Chief prose override failed observed criterion checks", async () => {
    const { mission, runtime, ports } = await fixture()
    ports.runAgent = vi.fn(async (_actor, _prompt, value, stage) => {
      if (stage === "work") {
        await writeFile(join(value.workspace.path, "result.txt"), "A self-reported claim without evidence")
        return "Everything is done."
      }
      if (stage === "supervise") return JSON.stringify({ action: "stop", reason: "The actual criterion is unmet." })
      return JSON.stringify(stage === "final-review" ? finalPassed : passed)
    })
    ports.verify = async (value) => {
      value.goalVerification = await executeGoalVerification(contract, value.workspace.path, {
        successCriteria: [criterion],
      })
      return { ok: true, output: "A false passing verdict" }
    }
    await expect(coordinate(mission, ports)).rejects.toThrow()
    expect(mission.status).not.toBe("completed")
    expect(mission.goalVerification?.ok).toBe(false)
    await runtime.close()
  })

  it("preserves the trusted command path for legacy missions without a generated contract", async () => {
    const { mission, runtime, ports } = await fixture()
    mission.verifyCommand = "git diff --check"
    delete mission.verificationMode
    delete mission.verificationContract
    delete mission.verificationContractSha256
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.goalVerification).toBeUndefined()
    await runtime.close()
  })
})
