import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { planSandboxedSpawn } from "../sessions/sandbox"
import { ChiefRuntime } from "./runtime"
import { discoverMissionSkills } from "./skills"
import { MissionStore } from "./store"
import type { ChiefStage, Mission, Persona } from "./types"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

let root: string
let runtime: ChiefRuntime
let mission: Mission
let chief: Persona

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-runtime-skills-"))
  chief = { id: "chief", name: "Chief Director", role: "Coordinate", agentType: "claude", skills: [] }
  mission = {
    id: "runtime-skills-test",
    goal: "Deliver a report",
    chiefId: chief.id,
    personas: [chief, { id: "worker", name: "Worker", role: "Implement", agentType: "claude", skills: [] }],
    availableAgents: ["claude"],
    workspace: {
      issueId: "runtime-skills-test",
      path: root,
      key: "runtime-skills-test",
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
  for (const name of ["oma-selected", "oma-new-report-skill"]) {
    const directory = join(root, ".agents/skills", name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Metadata for ${name}.\n---\nBODY_TOKEN_${name}`,
    )
  }
  mission.availableSkills = await discoverMissionSkills(root)
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

describe("Chief Director skill catalog guidance", () => {
  it("shows Chief Director the complete actual catalog and paths without loading unselected bodies", async () => {
    const output = await runtime.ports().runAgent(chief, "Plan the goal.", mission, "plan")
    expect(output).toContain(JSON.stringify(mission.availableSkills))
    expect(output).toContain("Choose relevant actual skills")
    expect(output).toContain("Read a selected SKILL.md at its listed path")
    expect(output).not.toContain("BODY_TOKEN_")
  })

  it.each<ChiefStage>(["plan", "review", "final-review", "supervise", "report"])(
    "keeps %s read-only even when a selected skill describes file operations",
    async (stage) => {
      chief.skills = ["oma-selected"]
      const before = await readFile(join(root, ".agents/skills/oma-selected/SKILL.md"))
      const output = await runtime.ports().runAgent(chief, "Read the evidence.", mission, stage)
      expect(output).toContain("BODY_TOKEN_oma-selected")
      expect(output).not.toContain("BODY_TOKEN_oma-new-report-skill")
      expect(output).toContain("This stage is read-only")
      expect(output).toContain("fixed verification command")
      expect(await readFile(join(root, ".agents/skills/oma-selected/SKILL.md"))).toEqual(before)
    },
  )

  it("loads only an assigned Actor skill and leaves work permissions intact", async () => {
    const worker = mission.personas[1]
    if (!worker) throw new Error("Expected the Actor test fixture.")
    worker.skills = ["oma-selected"]
    const output = await runtime.ports().runAgent(worker, "Implement the assigned report.", mission, "work")
    expect(output).toContain("BODY_TOKEN_oma-selected")
    expect(output).not.toContain("BODY_TOKEN_oma-new-report-skill")
    expect(output).not.toContain("Available OMA skills")
    expect(output).not.toContain("This stage is read-only")
  })

  it("rejects injected unselected catalog paths before launching any stage", async () => {
    const catalog = mission.availableSkills ?? []
    const skill = catalog[0]
    if (!skill) throw new Error("Expected the skill test fixture.")
    skill.path = join(root, "outside.md")
    await expect(runtime.ports().runAgent(chief, "Inspect evidence.", mission, "report")).rejects.toThrow(
      "no longer matches this worktree",
    )
    expect(planSandboxedSpawn).not.toHaveBeenCalled()
  })

  it("keeps explicit custom Actor skills supported alongside the discovered OMA catalog", async () => {
    delete mission.availableAgents
    const directory = join(root, ".agents/skills/custom-guide")
    await mkdir(directory)
    await writeFile(join(directory, "SKILL.md"), "Explicit custom body.")
    chief.skills = ["custom-guide"]
    const output = await runtime.ports().runAgent(chief, "Inspect evidence.", mission, "review")
    expect(output).toContain("Explicit custom body.")
    expect(output).toContain(JSON.stringify(mission.availableSkills))
  })

  it("discovers the current target catalog for legacy missions without saved metadata", async () => {
    delete mission.availableSkills
    const output = await runtime.ports().runAgent(chief, "Plan.", mission, "plan")
    expect(output).toContain("oma-new-report-skill")
    expect(output).not.toContain("BODY_TOKEN_")
  })
})
