import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SkillMatrixDeps } from "../oma/skill-matrix-adapter"
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
  function matrixDependencies(): SkillMatrixDeps {
    const hash = "a".repeat(64)
    const report = {
      schemaVersion: 1,
      kind: "skill-compatibility-matrix",
      protocolVersion: "oma-skill-matrix-v2",
      mode: "live",
      status: "completed",
      createdAt: new Date().toISOString(),
      omaVersion: "16.0.0",
      host: { platform: process.platform, arch: process.arch, node: process.version },
      suiteHash: hash,
      sourceKind: "installed",
      delivery: "injected",
      auditScope: "read-reference",
      bundle: {
        hash,
        skills: [
          {
            name: "oma-test-skill",
            hash,
            caseId: "read-oma-test-skill",
            requiredFiles: ["oma-test-skill/SKILL.md"],
            missingFiles: [],
            excludedReferences: [],
          },
        ],
      },
      cases: [{ id: "read-oma-test-skill", skill: "oma-test-skill" }],
      models: { claude: "measured", codex: null },
      cells: [
        {
          caseId: "read-oma-test-skill",
          skill: "oma-test-skill",
          vendor: "claude",
          status: "pass",
          contentHash: hash,
          checks: ["process", "output", "content", "integrity", "reference-coverage"].map((id) => ({
            id,
            status: "pass",
            detail: "Observed",
            ...(id === "content" ? { proof: "read" } : {}),
          })),
          nativeActivation: "unobserved",
          cliVersion: "2.0.0",
          model: "measured",
          durationMs: 1,
        },
      ],
    }
    return {
      now: Date.now,
      platform: process.platform,
      arch: process.arch,
      readReport: vi.fn(async () => report),
      plan: vi.fn(async () => ({ ...report, mode: "plan", status: "planned", cells: [] })),
      cliVersion: vi.fn(async () => "2.0.0"),
    }
  }
  async function compatibility(mode: "warn" | "require", injected = matrixDependencies()) {
    await mkdir(join(root, ".agents/skills/oma-test-skill"), { recursive: true })
    await writeFile(
      join(root, ".agents/skills/oma-test-skill/SKILL.md"),
      "---\nname: oma-test-skill\ndescription: Fixture check\n---\nFixture body",
    )
    worker.skills = ["oma-test-skill"]
    worker.model = "measured"
    mission.operatingPolicy = {
      memory: false,
      reviewVendor: "off",
      skillCompatibility: { reportPath: join(root, "matrix.json"), mode, maxAgeHours: 168 },
    }
    runtime = new ChiefRuntime(new MissionStore(join(root, "records")), undefined, undefined, injected)
    return injected
  }

  it("requires current skill evidence before spawning a fixed Actor and rechecks a resumed record", async () => {
    const injected = await compatibility("require")
    expect(await runtime.ports().runAgent(worker, "Work", mission, "work")).toContain("Fixture body")
    const store = new MissionStore(join(root, "records"))
    const resumed = await store.load(mission.id)
    expect(resumed.operatingPolicy?.skillCompatibility?.reportPath).toBe(join(root, "matrix.json"))
    injected.cliVersion = vi.fn(async () => "updated-cli")
    vi.mocked(planSandboxedSpawn).mockClear()
    await expect(runtime.ports().runAgent(worker, "Work again", resumed, "work")).rejects.toThrow(
      "configured Actor/model",
    )
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
    expect(injected.plan).toHaveBeenCalledTimes(2)
  })

  it("warns on unavailable evidence without changing a fixed Actor/model", async () => {
    const injected = await compatibility("warn")
    injected.readReport = vi.fn(async () => {
      throw new Error("missing")
    })
    expect(await runtime.ports().runAgent(worker, "Work", mission, "work")).toContain("Fixture body")
    expect(mission.operations?.runs[0]).toMatchObject({ actorType: "claude", model: "measured" })
    expect(
      mission.history.some((entry) => entry.stage === "skill-compatibility" && entry.message.includes("unknown")),
    ).toBe(true)
  })

  it("filters automatic candidates before ranking and plans against a parallel task workspace", async () => {
    const injected = await compatibility("require")
    mission.availableAgents = ["claude", "codex"]
    const policy = mission.operatingPolicy
    if (!policy) throw new Error("Fixture policy is missing")
    policy.readyActors = ["claude", "codex"]
    policy.routing = {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "codex", model: "cheap", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
        { actorType: "claude", model: "measured", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      ],
    }
    const task = join(root, "parallel")
    await mkdir(join(task, ".agents/skills/oma-test-skill"), { recursive: true })
    await writeFile(
      join(task, ".agents/skills/oma-test-skill/SKILL.md"),
      "---\nname: oma-test-skill\ndescription: Fixture check\n---\nParallel body",
    )
    const output = await runtime.ports().runAgent(worker, "Work", mission, "work", {
      workspace: { ...mission.workspace, path: task },
      signal: new AbortController().signal,
    })
    expect(output).toContain("Parallel body")
    expect(mission.operations?.runs[0]?.actorType).toBe("claude")
    expect(injected.plan).toHaveBeenCalledWith(task, ["oma-test-skill"], expect.any(AbortSignal))
  })

  it("keeps non-work stages outside the opt-in work filter", async () => {
    const injected = await compatibility("require")
    injected.readReport = vi.fn(async () => {
      throw new Error("unavailable")
    })
    expect(await runtime.ports().runAgent(worker, "Review", mission, "review")).toContain("Fixture body")
    expect(injected.readReport).not.toHaveBeenCalled()
  })

  it("marks the actual Actor process and prompt to prevent recursive AV delegation", async () => {
    vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',is_error:false,result:process.env.AGENT_VALLEY_MANAGED_RUN})+'\\n'))",
      ],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    }))
    expect(await runtime.ports().runAgent(worker, "Perform assigned work.", mission, "work")).toBe("1")
  })

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
