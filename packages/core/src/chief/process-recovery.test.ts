import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { planSandboxedSpawn } from "../sessions/sandbox"
import { ActiveMissionProcess } from "./active-process"
import { ChiefRuntime } from "./runtime"
import { MissionStore } from "./store"
import type { Mission } from "./types"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

let root: string
let runtime: ChiefRuntime
let mission: Mission
let pids: number[]

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Process did not create readiness marker ${path}`)
    await delay(10)
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function descendantCode(writeDelay = 450): string {
  return `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(join(root, "ready"))}, String(process.pid));
setTimeout(() => fs.writeFileSync(${JSON.stringify(join(root, "late-product-edit"))}, 'unexpected edit'), ${writeDelay});
setInterval(() => {}, 1000);
`
}

async function fakeAgent(completes: boolean): Promise<void> {
  const script = join(root, "agent.cjs")
  await writeFile(
    script,
    `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.stdin.resume();
process.stdin.on('end', () => {
  spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode())}], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(join(root, "Actor-pid"))}, String(process.pid));
  const ready = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(root, "ready"))})) return;
    clearInterval(ready);
    if (${JSON.stringify(completes)}) process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'Task complete'}) + '\\n');
  }, 5);
  setInterval(() => {}, 1000);
});
`,
  )
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: [script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-tree-"))
  pids = []
  mission = {
    id: "tree-test",
    goal: "Create a report",
    chiefId: "chief",
    personas: [
      { id: "chief", name: "Chief Director", role: "Coordinate", agentType: "claude", skills: [] },
      { id: "worker", name: "Worker", role: "Write", agentType: "claude", skills: [] },
    ],
    workspace: {
      issueId: "tree-test",
      path: root,
      key: "tree-test",
      branch: "chief/tree",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    tasks: [],
    history: [],
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
  }
  runtime = new ChiefRuntime(new MissionStore(join(root, "missions")))
})

afterEach(async () => {
  await runtime.close()
  for (const file of ["ready", "agent-pid"]) {
    const pid = Number(await readFile(join(root, file), "utf8").catch(() => ""))
    if (pid > 1) pids.push(pid)
  }
  for (const pid of pids) terminate(pid)
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe.skipIf(process.platform === "win32")("chief process tree ownership", () => {
  it("kills descendants after a terminal event before the next stage may inspect files", async () => {
    await fakeAgent(true)
    const actor = mission.personas[1]
    if (!actor) throw new Error("Missing Actor fixture")
    expect(await runtime.ports().runAgent(actor, "Do the work", mission, "work")).toBe("Task complete")
    expect(existsSync(join(root, "ready"))).toBe(true)
    await delay(650)
    expect(existsSync(join(root, "late-product-edit"))).toBe(false)
  }, 7_000)

  it("kills descendants on cancellation even when they ignore SIGTERM", async () => {
    await fakeAgent(false)
    const controller = new AbortController()
    runtime = new ChiefRuntime(new MissionStore(join(root, "missions")), controller.signal)
    const actor = mission.personas[1]
    if (!actor) throw new Error("Missing Actor fixture")
    const stopped = expect(runtime.ports().runAgent(actor, "Do the work", mission, "work")).rejects.toThrow(
      "interrupted",
    )
    await waitForFile(join(root, "ready"))
    controller.abort()
    await stopped
    await delay(650)
    expect(existsSync(join(root, "late-product-edit"))).toBe(false)
  }, 7_000)

  it("cleans up verification descendants even when their leader exits successfully", async () => {
    const script = join(root, "verifier.cjs")
    await writeFile(
      script,
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode())}], { stdio: 'ignore' });
setInterval(() => { if (fs.existsSync(${JSON.stringify(join(root, "ready"))})) process.exit(0); }, 5);
`,
    )
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    mission.verifyCommand = `${quote(process.execPath)} ${quote(script)}`
    expect((await runtime.ports().verify(mission)).ok).toBe(true)
    expect(existsSync(join(root, "ready"))).toBe(true)
    await delay(650)
    expect(existsSync(join(root, "late-product-edit"))).toBe(false)
  }, 7_000)

  it("blocks recovery while a dead leader's process group still has a live writer", async () => {
    const tracker = new ActiveMissionProcess(join(root, "missions"), mission.id)
    tracker.begin("work")
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode(2_000))}], { stdio: 'ignore' });
setInterval(() => { if (fs.existsSync(${JSON.stringify(join(root, "ready"))})) process.exit(0); }, 5);
`,
      ],
      { detached: true, stdio: "ignore" },
    )
    if (!leader.pid) throw new Error("Failed to launch process-group fixture")
    const group = leader.pid
    pids.push(group)
    tracker.spawned(group, true)
    await new Promise<void>((resolve, reject) => {
      leader.once("exit", () => resolve())
      leader.once("error", reject)
    })
    await waitForFile(join(root, "ready"))
    const recovery = new ActiveMissionProcess(join(root, "missions"), mission.id)
    expect(() => recovery.assertIdle()).toThrow(/active|running|alive|stop/i)
    process.kill(-group, "SIGKILL")
    await vi.waitFor(() => expect(() => recovery.assertIdle()).not.toThrow(), { timeout: 1_000, interval: 20 })
    tracker.finish()
    expect(() => recovery.assertIdle()).not.toThrow()
    await delay(100)
    expect(existsSync(join(root, "late-product-edit"))).toBe(false)
  }, 7_000)
})
