import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { MissionStore } from "@agent-valley/core/chief/store"
import { planSandboxedSpawn } from "@agent-valley/core/sessions/sandbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runOrder } from "../chief"

vi.mock("@agent-valley/core/sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))
vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))

const exec = promisify(execFile)
const verify =
  'mkdir -p .agent-valley && test "$(cat deliverable.txt)" = accepted && printf verified > .agent-valley/verified.txt'
let root: string
let repo: string
let logPath: string

async function fakeClaude(mode: "success" | "repair" | "interrupt" = "success") {
  const script = join(root, "fake-claude.cjs")
  await writeFile(
    script,
    `
const fs = require('node:fs');
const log = ${JSON.stringify(logPath)};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const stage = prompt.startsWith('You are the chief') ? 'plan'
    : prompt.startsWith('Perform the chief') ? 'final-review'
    : prompt.startsWith('Independently review') ? 'review' : 'work';
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
  const workers = calls.filter(call => call.stage === 'work').length;
  fs.appendFileSync(log, JSON.stringify({ stage, cwd: process.cwd(), prompt }) + '\\n');
  let result;
  let isError = false;
  if (stage === 'plan') {
    result = JSON.stringify({ tasks: [{ id: 'write', title: 'Write deliverable', personaId: 'engineer',
      instructions: 'Create deliverable.txt containing accepted', acceptance: ['deliverable.txt contains accepted'], dependencies: [] }] });
  } else if (stage === 'work') {
    const wrong = ${JSON.stringify(mode)} !== 'success' && workers === 0;
    fs.writeFileSync('deliverable.txt', wrong ? 'partial' : 'accepted');
    isError = ${JSON.stringify(mode)} === 'interrupt' && workers === 0;
    result = isError ? 'Simulated CLI connection failure' : 'Wrote deliverable.txt. Inspect it and run the acceptance check.';
  } else {
    const delivered = fs.existsSync('deliverable.txt');
    result = JSON.stringify({ passed: delivered, summary: 'Inspected deliverable.txt in the mission worktree.', findings: delivered ? [] : ['Write deliverable.txt'] });
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: isError, result, duration_ms: 1 }) + '\\n');
});
`,
  )
  vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
    command: process.execPath,
    args: [script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-cli-"))
  repo = join(root, "repo")
  logPath = join(root, "calls.jsonl")
  await mkdir(repo)
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo })
  await exec("git", ["config", "user.email", "chief-test@example.test"], { cwd: repo })
  await exec("git", ["config", "user.name", "Chief Test"], { cwd: repo })
  await writeFile(join(repo, "README.md"), "Mission fixture\n")
  await exec("git", ["add", "README.md"], { cwd: repo })
  await exec("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign"], { cwd: repo })
  vi.spyOn(console, "log").mockImplementation(() => {})
  await fakeClaude()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function calls(): Promise<Array<{ stage: string; cwd: string; prompt: string }>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

describe("chief CLI mission lifecycle with real sessions and Git", () => {
  it("completes an order without tracker config, preserves isolation, and rechecks a saved mission", async () => {
    const sigint = process.listenerCount("SIGINT")
    const mission = await runOrder(
      "Create a verified deliverable",
      { workspace: repo, verify, agent: "claude", timeout: "10" },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.status).toBe("completed")
    expect(mission.tasks[0]?.reviewerId).toBe("reviewer")
    expect(mission.workspace.path).not.toBe(repo)
    expect(await readFile(join(mission.workspace.path, "deliverable.txt"), "utf8")).toBe("accepted")
    expect(await readFile(join(mission.workspace.path, ".agent-valley/verified.txt"), "utf8")).toBe("verified")
    await expect(readFile(join(repo, "deliverable.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await calls()).map((call) => call.stage)).toEqual(["plan", "work", "review", "final-review"])
    const canonicalWorkspace = await realpath(mission.workspace.path)
    expect((await calls()).every((call) => call.cwd === canonicalWorkspace)).toBe(true)
    expect(await new MissionStore(join(root, ".agent-valley/missions")).load(mission.id)).toEqual(mission)
    const resumed = await runOrder(undefined, { resume: mission.id }, root)
    expect(resumed.status).toBe("completed")
    expect(resumed.tasks[0]?.attempts).toBe(1)
    expect((await calls()).map((call) => call.stage)).toEqual([
      "plan",
      "work",
      "review",
      "final-review",
      "final-review",
    ])
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([`${mission.id}.json`])
    expect(process.listenerCount("SIGINT")).toBe(sigint)
  }, 20_000)

  it("repairs real verifier failures instead of trusting successful worker and reviewer messages", async () => {
    await fakeClaude("repair")
    const mission = await runOrder(
      "Create a verified deliverable",
      { workspace: repo, verify, agent: "claude", repairs: "1", timeout: "10" },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.attempts).toBe(2)
    expect(mission.repairRound).toBe(1)
    expect((await calls()).map((call) => call.stage)).toEqual([
      "plan",
      "work",
      "review",
      "work",
      "review",
      "final-review",
    ])
    expect(await readFile(join(mission.workspace.path, "deliverable.txt"), "utf8")).toBe("accepted")
  }, 20_000)

  it("retains a failed worktree and resumes interrupted work from durable state", async () => {
    await fakeClaude("interrupt")
    await expect(
      runOrder(
        "Create a verified deliverable",
        { workspace: repo, verify, agent: "claude", repairs: "0", timeout: "10" },
        root,
      ),
    ).rejects.toThrow("Simulated CLI connection failure")
    const store = new MissionStore(join(root, ".agent-valley/missions"))
    const [failed] = await store.list()
    if (!failed) throw new Error("Expected saved failed mission")
    expect(failed.status).toBe("failed")
    expect(await readFile(join(failed.workspace.path, "deliverable.txt"), "utf8")).toBe("partial")
    const resumed = await runOrder(undefined, { resume: failed.id }, root)
    expect(resumed.status).toBe("completed")
    expect(resumed.workspace.path).toBe(failed.workspace.path)
    expect(resumed.tasks[0]?.attempts).toBe(2)
    expect((await calls()).filter((call) => call.stage === "plan")).toHaveLength(1)
  }, 20_000)

  it("rejects resume contract changes and releases its lock after CLI validation errors", async () => {
    await expect(runOrder(undefined, { workspace: repo, verify }, root)).rejects.toThrow("Give the chief a goal")
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([])
    await expect(runOrder("Changed goal", { resume: "mission-id" }, root)).rejects.toThrow("Pass only --resume")
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([])
  })
})
