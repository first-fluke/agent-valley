import { execFileSync, spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { fingerprintWorkspace } from "@agent-valley/core/chief/fingerprint"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import type { Mission } from "@agent-valley/core/chief/types"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
let bun: string
let root: string
let env: Record<string, string>

beforeAll(() => {
  bun = execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" })
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "av-order-exit-")))
  mkdirSync(join(root, "home"))
  mkdirSync(join(root, "bin"))
  const git = (process.env.PATH ?? "")
    .split(delimiter)
    .map((path) => join(path, "git"))
    .find(existsSync)
  if (!git) throw new Error("Fixture requires Git.")
  symlinkSync(realpathSync(git), join(root, "bin", "git"))
  for (const native of ["claude", "codex", "qwen", "agy", "cursor", "grok", "kimi", "opencode"])
    writeFileSync(join(root, "bin", native), "#!/bin/sh\nexit 91\n", { mode: 0o755 })
  env = {
    PATH: [join(root, "bin"), "/usr/bin", "/bin"].join(delimiter),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_HOME: join(root, "home", ".codex"),
    CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    CI: "true",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function pausedCheckpoint() {
  const mission = missionFixture()
  mission.status = "paused"
  mission.error = "Restore provider authentication before continuing."
  mission.executionPolicy = executionPolicySchema.parse({})
  mission.execution = {
    startedAt: new Date().toISOString(),
    runsStarted: 4,
    retries: 0,
    failureKind: "authentication",
    pauseReason: mission.error,
  }
  saveCheckpoint(mission)
  return mission
}

function saveCheckpoint(mission: Mission): void {
  const directory = join(root, ".agent-valley", "missions")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${mission.id}.json`), JSON.stringify({ version: 1, mission }))
}

function loadCheckpoint(id: string): Mission {
  return JSON.parse(readFileSync(join(root, ".agent-valley", "missions", `${id}.json`), "utf8")).mission
}

function cliArgs(id: string, supervise: boolean): string[] {
  return [entry, "order", "--resume", id, ...(supervise ? [] : ["--no-supervise"])]
}

async function nativeCheckpoint(mode: "success" | "failed" | "rate-limit" | "wait"): Promise<Mission> {
  const mission = missionFixture()
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace, env })
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: workspace, env },
  )
  writeFileSync(join(workspace, "deliverable.txt"), "accepted")
  mission.workspace.path = workspace
  mission.workspace.branch = "main"
  mission.status = "reviewing"
  mission.timeoutSec = 15
  mission.maxRepairs = 0
  mission.verifyCommand = mode === "failed" ? "false" : "test -s deliverable.txt"
  mission.goalBrief = {
    interpretation: "Create a checked file",
    assumptions: [],
    successCriteria: ["The deliverable exists"],
  }
  mission.personas = mission.personas.map((persona) => ({ ...persona, agentType: "claude", skills: [] }))
  delete mission.supervision
  mission.initialFingerprint = "before-the-deliverable"
  mission.fingerprint = await fingerprintWorkspace(workspace)
  if (mode === "rate-limit" || mode === "wait") {
    mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    mission.execution = { startedAt: new Date().toISOString(), runsStarted: 0, retries: 0 }
  }
  // Keep OS containment checks in their dedicated tests. These subprocess tests
  // permit only the fake native executable in this isolated Git fixture.
  const sandbox = fileURLToPath(new URL("../../../../packages/core/src/sessions/sandbox.ts", import.meta.url))
  const preload = join(root, "fixture-preload.ts")
  writeFileSync(
    preload,
    `import { mock } from "bun:test";
mock.module(${JSON.stringify(sandbox)}, () => ({ planSandboxedSpawn: async (request) => {
  if (request.command !== "claude" || request.workspacePath !== ${JSON.stringify(workspace)}) throw new Error("Fixture rejected native spawn");
  return { command: request.command, args: request.args, sandboxed: false, platform: process.platform, networkAllowlist: [] };
} }));
globalThis.fetch = async () => { throw new Error("Fixture forbids external requests"); };
`,
  )
  writeFileSync(join(root, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`)
  // This local CLI only reads a supplied prompt and emits recorded native NDJSON.
  // No provider binary, credentials, network or model is used.
  const script = join(root, "native-session.cjs")
  writeFileSync(
    script,
    `
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify({ pid: process.pid, prompt, args: process.argv.slice(2) }) + '\\n');
  if (${JSON.stringify(mode)} === 'wait') { setInterval(() => {}, 1000); return; }
  const result = ${JSON.stringify(mode)} === 'rate-limit' ? 'Rate limit exceeded' : JSON.stringify({ passed: true, summary: 'Inspected the file', findings: [], criteria: [{ criterion: 'The deliverable exists', passed: true, evidence: 'Read deliverable.txt' }] });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: ${JSON.stringify(mode)} === 'rate-limit', result, duration_ms: 1 }) + '\\n');
});
`,
    { mode: 0o755 },
  )
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(
    join(root, "bin", "claude"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@" 2>${quote(join(root, "native-stderr"))}\n`,
    { mode: 0o755 },
  )
  saveCheckpoint(mission)
  return mission
}

describe("source order CLI outcome", () => {
  it("resumes a completed continuing order through the public order command without starting native work", () => {
    const repository = join(root, "target-repository")
    mkdirSync(repository)
    const directory = join(root, ".agent-valley", "operations")
    mkdirSync(directory, { recursive: true })
    const id = "completed-continuing-order"
    const now = new Date().toISOString()
    const operation = {
      id,
      repositoryRoot: repository,
      charter: "Improve usability and revenue",
      settings: { workspace: repository, actor: "codex", model: "chosen-model" },
      phase: "completed",
      completedCycles: 1,
      cycleLimit: 1,
      waitIntervalSec: 300,
      history: [],
      createdAt: now,
      updatedAt: now,
    }
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 1, operation }))
    const child = spawnSync(bun, [entry, "order", "--resume", id], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr + child.stdout).toBe(0)
    expect(child.stdout).toContain(`Order ${id}: completed; 1 verified improvements.`)
    expect(child.stdout).toContain(`Resume: av order --resume ${id}`)
    expect(existsSync(join(root, ".agent-valley", "missions"))).toBe(false)
    expect(existsSync(join(root, "calls.jsonl"))).toBe(false)
    expect(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8")).operation.settings).toEqual(
      operation.settings,
    )
  }, 15_000)

  it.each([true, false])(
    "reports a paused checkpoint and exit 2 with supervision=%s",
    (supervise) => {
      const mission = pausedCheckpoint()
      const child = spawnSync(bun, cliArgs(mission.id, supervise), {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status).toBe(2)
      expect(child.stdout).toContain("Order paused")
      expect(child.stdout).toContain(mission.error)
      expect(child.stdout).toContain(`Report: .agent-valley/reports/${mission.id}.md`)
      expect(child.stdout).not.toContain("--retry")
      const saved = loadCheckpoint(mission.id)
      expect(saved.status).toBe("paused")
      expect(saved.execution?.runsStarted).toBe(4)
    },
    15_000,
  )

  it.each([true, false])(
    "returns exit 0 only after verification and native final review with supervision=%s",
    async (supervise) => {
      const mission = await nativeCheckpoint("success")
      const child = spawnSync(bun, cliArgs(mission.id, supervise), {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })
      expect(child.error).toBeUndefined()
      expect(
        child.status,
        child.stderr +
          child.stdout +
          (existsSync(join(root, "native-stderr")) ? readFileSync(join(root, "native-stderr"), "utf8") : ""),
      ).toBe(0)
      expect(child.stdout).toContain("Order completed")
      expect(loadCheckpoint(mission.id).verification?.ok).toBe(true)
      expect(loadCheckpoint(mission.id).finalReview?.passed).toBe(true)
      expect(readFileSync(join(root, "calls.jsonl"), "utf8")).toContain("Perform the Chief Director")
    },
    15_000,
  )

  it.each([true, false])(
    "returns exit 1 with the verifier failure and saved report with supervision=%s",
    async (supervise) => {
      const mission = await nativeCheckpoint("failed")
      const child = spawnSync(bun, cliArgs(mission.id, supervise), {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(1)
      expect(child.stdout).toContain("Order failed")
      expect(child.stdout).toContain("The operator's verification command failed")
      expect(child.stdout).toContain(`Report: .agent-valley/reports/${mission.id}.md`)
      expect(child.stdout).not.toContain("--retry")
      expect(loadCheckpoint(mission.id).status).toBe("failed")
      expect(loadCheckpoint(mission.id).verification?.ok).toBe(false)
    },
    15_000,
  )

  it("returns exit 2 and a scheduled time for provider waiting without supervision", async () => {
    const mission = await nativeCheckpoint("rate-limit")
    const child = spawnSync(bun, cliArgs(mission.id, false), {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr + child.stdout).toBe(2)
    expect(child.stdout).toContain("Order waiting")
    expect(child.stdout).toContain("Rate limit exceeded")
    expect(child.stdout).toContain("Next attempt:")
    expect(loadCheckpoint(mission.id).status).toBe("waiting")
  }, 15_000)

  it("returns exit 1 for a local report write failure after verified completion without replaying native work", async () => {
    const mission = await nativeCheckpoint("success")
    writeFileSync(join(root, ".agent-valley", "reports"), "blocked report directory")
    const child = spawnSync(bun, cliArgs(mission.id, true), {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(child.stderr).toContain("Verified work remains completed")
    expect(loadCheckpoint(mission.id).status).toBe("completed")
    expect(loadCheckpoint(mission.id).verification?.ok).toBe(true)
    expect(loadCheckpoint(mission.id).execution?.crashRestarts).toBeUndefined()
    expect(readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
  }, 15_000)

  it.each([
    { supervise: true, legacy: false },
    { supervise: false, legacy: false },
    { supervise: false, legacy: true },
  ])(
    "joins cancelled native sessions and returns a resumable exit 2 with supervision=$supervise, legacy=$legacy",
    async ({ supervise, legacy }) => {
      const mission = await nativeCheckpoint("wait")
      if (legacy) {
        delete mission.executionPolicy
        delete mission.execution
        saveCheckpoint(mission)
      }
      const child = spawn(bun, cliArgs(mission.id, supervise), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000)
      let output = ""
      child.stdout.on("data", (chunk) => {
        output += chunk
      })
      child.stderr.on("data", (chunk) => {
        output += chunk
      })
      const stopped = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject)
        child.once("close", resolveExit)
      })
      try {
        const deadline = Date.now() + 8_000
        while (!existsSync(join(root, "calls.jsonl"))) {
          if (Date.now() >= deadline) throw new Error(`Native fixture did not start: ${output}`)
          await new Promise((resolveWait) => setTimeout(resolveWait, 10))
        }
        child.kill("SIGTERM")
        expect(await stopped, output).toBe(2)
        expect(output).toContain("Order paused")
        expect(output).toContain(`Report: .agent-valley/reports/${mission.id}.md`)
        expect(loadCheckpoint(mission.id).execution?.failureKind).toBe("interrupted")
        expect(readdirSync(join(root, ".agent-valley", "missions"))).toEqual([`${mission.id}.json`])
        const { pid } = JSON.parse(readFileSync(join(root, "calls.jsonl"), "utf8").trim())
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await stopped
      }
    },
    15_000,
  )
})
