import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import { DshSession } from "./dsh-session"
import * as sandbox from "./sandbox"

const SESSION = { type: "session", sessionId: "session-owned", cwd: "/work" }
const FINAL = { type: "final", sessionId: "session-owned", reason: { kind: "completed" }, text: "final answer" }
let workspace: string
let session: DshSession
let events: AgentEvent[]

function fakeProcess(frames: unknown[], exitCode = 0, keepAlive = false) {
  const payload = frames.map((event) => JSON.stringify(event)).join("\n")
  vi.spyOn(sandbox, "planSandboxedSpawn").mockResolvedValue({
    command: process.execPath,
    args: [
      "-e",
      `
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        if (input !== "stdin prompt") process.exitCode = 3;
        else {
          process.stdout.write(${JSON.stringify(payload)});
          ${keepAlive ? 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);' : `process.exitCode = ${exitCode};`}
        }
      });
    `,
    ],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
}

async function run(frames: unknown[], exitCode = 0) {
  fakeProcess(frames, exitCode)
  await session.start({ type: "dsh", workspacePath: workspace, timeout: 10 })
  await session.execute("stdin prompt")
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "av-dsh-session-"))
  session = new DshSession()
  events = []
  for (const type of ["output", "toolUse", "heartbeat", "complete", "error", "spawned"] as const) {
    session.on(type, (event) => events.push(event))
  }
})

afterEach(async () => {
  await session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("DSH native headless JSON protocol", () => {
  it("passes stdin to verified native arguments and keeps final text distinct from progress", async () => {
    await run([
      SESSION,
      { type: "text", text: "progress" },
      { type: "tool_call", tool: "bash", input: { command: "pwd" } },
      FINAL,
    ])
    expect(sandbox.planSandboxedSpawn).toHaveBeenCalledWith({
      agentType: "dsh",
      command: "dsh",
      args: [
        "--profile",
        "headless",
        "--json",
        "--permission-mode",
        "danger-full-access",
        "--approval-policy",
        "never",
        "-",
      ],
      workspacePath: workspace,
      env: expect.any(Object),
    })
    expect(events.find((event) => event.type === "complete")?.result.output).toBe("final answer")
    expect(events.filter((event) => event.type === "output")).toEqual([{ type: "output", chunk: "progress" }])
    expect(events.find((event) => event.type === "toolUse")).toMatchObject({ tool: "bash", args: { command: "pwd" } })
    expect(session.isAlive()).toBe(false)
  })

  it.each(
    [
      [],
      [SESSION],
      [FINAL],
      [SESSION, { ...FINAL, sessionId: "foreign-session" }],
      [SESSION, { ...FINAL, reason: null }],
      [SESSION, { ...FINAL, reason: { kind: "aborted" } }],
      [SESSION, { ...FINAL, text: undefined }],
      [SESSION, FINAL, FINAL],
      [SESSION, { type: "error", message: "failed" }, FINAL],
    ].map((frames) => ({ frames })),
  )("requires matching native session and unique completed final ($frames)", async ({ frames }) => {
    await run(frames)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(events.some((event) => event.type === "error")).toBe(true)
  })

  it("waits for successful process exit even after a completed final", async () => {
    await run([SESSION, FINAL], 1)
    expect(events.some((event) => event.type === "complete")).toBe(false)
  })

  it("sums step usage including retries without double counting cache subsets", async () => {
    await run([
      SESSION,
      { type: "status", phase: "step_end", usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10 } },
      { type: "status", phase: "step_end", usage: { inputTokens: 30, outputTokens: 4 } },
      FINAL,
    ])
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toEqual({
      input: 50,
      output: 9,
      model: "dsh-native-route",
    })
  })

  it.each([
    undefined,
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: "10", outputTokens: 2 },
    { inputTokens: 1.5, outputTokens: 2 },
  ])("leaves incomplete or malformed aggregate usage unknown (%j)", async (usage) => {
    await run([
      SESSION,
      { type: "status", phase: "step_end", usage: { inputTokens: 2, outputTokens: 1 } },
      { type: "status", phase: "step_end", usage },
      FINAL,
    ])
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toBeUndefined()
  })

  it("propagates classified exhaustion without raw error credentials", async () => {
    await run(
      [SESSION, { ...FINAL, reason: { kind: "error", error: { code: "context_length_exceeded", message: "SECRET" } } }],
      1,
    )
    expect(events.find((event) => event.type === "error")?.error.message).toContain("context_length_exceeded")
    expect(JSON.stringify(events)).not.toContain("SECRET")
  })

  it("resets session identity, usage and final state between executions", async () => {
    await run([SESSION, { type: "status", phase: "step_end", usage: { inputTokens: 2, outputTokens: 1 } }, FINAL])
    events.length = 0
    fakeProcess([
      { ...SESSION, sessionId: "second" },
      { ...FINAL, sessionId: "second" },
    ])
    await session.execute("stdin prompt")
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toBeUndefined()
  })

  it("does not interpret a graceful cancelled exit zero as completion", async () => {
    fakeProcess([SESSION, { type: "status", phase: "turn_start" }, FINAL], 0, true)
    await session.start({ type: "dsh", workspacePath: workspace, timeout: 10 })
    const ready = new Promise<void>((resolve) => session.on("heartbeat", () => resolve()))
    const execution = session.execute("stdin prompt")
    await ready
    await session.cancel()
    await execution
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(session.isAlive()).toBe(false)
  })

  it("rejects unsupported model overrides rather than silently ignoring them", async () => {
    await expect(
      session.start({ type: "dsh", workspacePath: workspace, timeout: 10, model: "unapplied" }),
    ).rejects.toThrow("no per-invocation model flag")
  })
})
