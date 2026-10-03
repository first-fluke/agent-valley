import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { planSandboxedSpawn } from "../sessions/sandbox"
import { ChiefRuntime } from "./runtime"
import { MissionStore } from "./store"
import type { Mission, Persona } from "./types"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

let root: string
let runtime: ChiefRuntime
let mission: Mission
let worker: Persona

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-runtime-"))
  worker = { id: "engineer", name: "Engineer", role: "Implement", agentType: "claude", skills: [] }
  mission = {
    id: "runtime-test",
    goal: "Deliver a report",
    chiefId: "chief",
    personas: [{ id: "chief", name: "Chief Director", role: "Coordinate", agentType: "claude", skills: [] }, worker],
    workspace: {
      issueId: "runtime-test",
      path: root,
      key: "runtime-test",
      branch: "chief/test",
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
  }
  runtime = new ChiefRuntime(new MissionStore(join(root, "records")))
  vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
    command: process.execPath,
    args: [
      "-e",
      "let p=''; process.stdin.on('data', c=>p+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',is_error:false,result:p})+'\\n'));",
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

describe("chief runtime boundaries", () => {
  it("adds only a selected skill's real content to the launched Actor prompt", async () => {
    const directory = join(root, ".agents/skills/test-skill")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), "Synthetic skill: write an evidence report.")
    worker.skills = ["test-skill"]
    const output = await runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")
    expect(output).toContain("Synthetic skill: write an evidence report.")
    expect(output).toContain("Skill test-skill")
    expect(planSandboxedSpawn).toHaveBeenCalledOnce()
  })

  it("fails before spawning when a configured skill harness is missing", async () => {
    worker.skills = ["test-skill"]
    await expect(runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).rejects.toThrow(
      "Install its OMA harness",
    )
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
  })

  it("rejects skills that escape the repository skill directory", async () => {
    const directory = join(root, ".agents/skills/test-skill")
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, "outside.md"), "Outside instructions")
    await symlink(join(root, "outside.md"), join(directory, "SKILL.md"))
    worker.skills = ["test-skill"]
    await expect(runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).rejects.toThrow(
      "escapes the skill directory",
    )
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
  })

  it("bounds skill loading and rejects invalid names before spawning", async () => {
    const directory = join(root, ".agents/skills/test-skill")
    await mkdir(directory, { recursive: true })
    worker.skills = ["../outside"]
    await expect(runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).rejects.toThrow(
      "Invalid skill name",
    )
    worker.skills = ["test-skill"]
    await writeFile(join(directory, "SKILL.md"), "x".repeat(256_001))
    await expect(runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).rejects.toThrow("256 KB")
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
  })

  it("rejects an aborted Actor stage before launching a child process", async () => {
    runtime = new ChiefRuntime(new MissionStore(join(root, "records")), AbortSignal.abort())
    await expect(runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).rejects.toThrow(
      "interrupted",
    )
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
  })

  it("never treats a missing verification command as success", async () => {
    mission.verifyCommand = " "
    await expect(runtime.ports().verify(mission)).rejects.toThrow("trusted verification command is required")
  })

  it("passes cancellation to a real running verification command", async () => {
    const controller = new AbortController()
    runtime = new ChiefRuntime(new MissionStore(join(root, "records")), controller.signal)
    mission.verifyCommand = `'${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'`
    const timer = setTimeout(() => controller.abort(), 100)
    try {
      const result = await runtime.ports().verify(mission)
      expect(result.ok).toBe(false)
      expect(result.output).toContain("Verification cancelled.")
    } finally {
      clearTimeout(timer)
    }
  }, 3_000)
})
