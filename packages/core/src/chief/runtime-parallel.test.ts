import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { planSandboxedSpawn } from "../sessions/sandbox"
import { runCommand } from "../workspace/worktree-lifecycle"
import { executionPolicySchema } from "./execution"
import { ChiefRuntime } from "./runtime"
import { discoverMissionSkills } from "./skills"
import { MissionStore } from "./store"
import type { Mission, Persona } from "./types"
import { goalVerificationContractDigest, validateGoalVerificationContract } from "./verification"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))
let root: string
let runtime: ChiefRuntime
let mission: Mission
let actor: Persona
const skill = "---\nname: oma-backend\ndescription: Synthetic backend instructions\n---\nUse the actual child worktree."

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-runtime-parallel-"))
  actor = { id: "actor", name: "Actor", role: "Implement", agentType: "claude", skills: ["oma-backend"] }
  mission = {
    id: "runtime-parallel",
    goal: "Deliver the goal",
    chiefId: "chief",
    personas: [{ id: "chief", name: "Chief Director", role: "Supervise", agentType: "claude", skills: [] }, actor],
    availableAgents: ["claude"],
    workspace: {
      issueId: "runtime-parallel",
      path: root,
      key: "runtime-parallel",
      branch: "chief/test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "git diff --check",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
  for (const args of [
    ["init", "-b", "chief/test"],
    ["config", "user.name", "AV Test"],
    ["config", "user.email", "av@example.invalid"],
  ]) {
    const result = await runCommand("git", args, { cwd: root })
    if (result.exitCode !== 0) throw new Error(result.stderr)
  }
  await writeFile(join(root, ".gitignore"), ".agents/\n.agent-valley/\n")
  await writeFile(join(root, "baseline.txt"), "baseline")
  await runCommand("git", ["add", ".gitignore", "baseline.txt"], { cwd: root })
  await runCommand("git", ["commit", "-m", "test baseline"], { cwd: root })
  await mkdir(join(root, ".agents/skills/oma-backend"), { recursive: true })
  await writeFile(join(root, ".agents/skills/oma-backend/SKILL.md"), skill)
  mission.availableSkills = await discoverMissionSkills(root)
  runtime = new ChiefRuntime(new MissionStore(join(root, ".agent-valley/missions")))
  vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
    command: process.execPath,
    args: [
      "-e",
      "let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({type:'result',is_error:false,result:p})+'\\n'),p.includes('SLOW')?250:20));",
    ],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  }))
})
afterEach(async () => {
  await runtime.close()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("Chief Runtime isolated Actor execution", () => {
  it("prepares ignored installed skills and rebinds their catalog paths to each child worktree", async () => {
    const ports = runtime.ports()
    const child = await ports.parallel?.prepare(mission, "task-one", 1)
    if (!child) throw new Error("Expected child worktree")
    expect(await readFile(join(child.path, ".agents/skills/oma-backend/SKILL.md"), "utf8")).toBe(skill)
    const output = await ports.runAgent(actor, "Perform child work.", mission, "work", {
      taskId: "task-one",
      workspace: { ...mission.workspace, path: child.path, branch: child.branch },
    })
    expect(output).toContain(`Source: ${join(child.path, ".agents/skills/oma-backend/SKILL.md")}`)
    expect(output).toContain("Use the actual child worktree.")
    expect(mission.availableSkills?.[0]?.path).toBe(join(await realpath(root), ".agents/skills/oma-backend/SKILL.md"))
    expect(planSandboxedSpawn).toHaveBeenCalledOnce()
  })

  it("lets a slow sibling finish after another isolated Actor disposes its runner", async () => {
    const ports = runtime.ports()
    const children = await Promise.all([
      ports.parallel?.prepare(mission, "fast", 1),
      ports.parallel?.prepare(mission, "slow", 1),
    ])
    const run = (index: number, prompt: string) => {
      const child = children[index]
      if (!child) throw new Error("Expected child worktree")
      return ports.runAgent(actor, prompt, mission, "work", {
        taskId: child.taskId,
        workspace: { ...mission.workspace, path: child.path, branch: child.branch },
      })
    }
    const [fast, slow] = await Promise.all([run(0, "FAST Actor"), run(1, "SLOW Actor")])
    expect(fast).toContain("FAST Actor")
    expect(slow).toContain("SLOW Actor")
    expect(planSandboxedSpawn).toHaveBeenCalledTimes(2)
    expect(mission.operations?.runs.every((entry) => entry.finishedAt && entry.outcome !== "failed")).toBe(true)
    const markers = await readdir(join(root, ".agent-valley/missions"))
    expect(markers.filter((name) => name.endsWith(".active"))).toEqual([])
  })

  it("retains deadline budget classification after joining a real typed verification process", async () => {
    await writeFile(join(root, "waiting.test.mjs"), "setInterval(()=>{},1000)")
    mission.verifyCommand = ""
    mission.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 1 })
    mission.execution = { startedAt: new Date(Date.now() - 800).toISOString(), runsStarted: 0, retries: 0 }
    mission.goalBrief = {
      interpretation: "Wait for test evidence",
      assumptions: [],
      successCriteria: ["The test passes"],
    }
    mission.verificationContract = validateGoalVerificationContract(
      {
        version: 1,
        criteria: [
          {
            criterion: "The test passes",
            checks: [{ kind: "command", program: "node", args: ["--test", "waiting.test.mjs"] }],
          },
        ],
      },
      ["The test passes"],
    )
    mission.verificationContractSha256 = goalVerificationContractDigest(mission.verificationContract)
    await expect(runtime.ports().verify(mission)).rejects.toMatchObject({ kind: "budget" })
    const markers = await readdir(join(root, ".agent-valley/missions"))
    expect(markers.filter((name) => name.endsWith(".active"))).toEqual([])
  })
})
