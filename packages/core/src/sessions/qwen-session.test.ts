import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import { QwenSession } from "./qwen-session"
import * as sandbox from "./sandbox"

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  usage: { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 80 },
}
let workspace: string
let session: QwenSession
let events: AgentEvent[]

function fakeProcess(
  frames: unknown[],
  exitCode = 0,
  options: { keepAlive?: boolean; stderr?: boolean; prefix?: string } = {},
) {
  const payload = frames.map((frame) => JSON.stringify(frame)).join("\n")
  const script = `
    let input = ""; process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      process.stdout.write(${JSON.stringify(options.prefix ?? "")});
      process.stdout.write(${JSON.stringify(payload)});
      ${options.stderr ? 'process.stderr.write("x".repeat(1048576));' : ""}
      ${options.keepAlive ? "setInterval(() => {}, 1000);" : `process.exitCode = ${exitCode};`}
    });
  `
  vi.spyOn(sandbox, "planSandboxedSpawn").mockResolvedValue({
    command: process.execPath,
    args: ["-e", script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
}

async function run(frames: unknown[], exitCode = 0, config: { model?: string } = {}) {
  fakeProcess(frames, exitCode)
  await session.start({ type: "qwen", workspacePath: workspace, timeout: 10, ...config })
  await session.execute("operator prompt through stdin")
  return events
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "av-qwen-session-"))
  session = new QwenSession()
  events = []
  for (const type of ["output", "toolUse", "fileChange", "heartbeat", "complete", "error", "spawned"] as const) {
    session.on(type, (event) => events.push(event))
  }
})
afterEach(async () => {
  await session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("Qwen Code native single-shot session", () => {
  it("uses verified stdin/stream-json flags, model pin and OS sandbox without Claude flags", async () => {
    await run([{ type: "system", subtype: "session_start", model: "actual-qwen-model" }, SUCCESS], 0, {
      model: "pinned-model",
    })
    expect(sandbox.planSandboxedSpawn).toHaveBeenCalledWith({
      agentType: "qwen",
      command: "qwen",
      args: ["--output-format", "stream-json", "--yolo", "--model", "pinned-model"],
      workspacePath: workspace,
    })
    const complete = events.find((event) => event.type === "complete")
    expect(complete?.result.tokenUsage).toEqual({ input: 100, output: 12, model: "actual-qwen-model" })
    expect(complete?.result.output).toBe("done")
    expect(session.isAlive()).toBe(false)
  })

  it("streams native text/tools, deduplicates changed paths and flushes a final unterminated JSON line", async () => {
    await run([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", name: "write_file", input: { file_path: "new.ts" } },
            { type: "tool_use", name: "edit", input: { file_path: "old.ts" } },
            { type: "tool_use", name: "replace", input: { file_path: "old.ts" } },
          ],
        },
      },
      SUCCESS,
    ])
    expect(events.filter((event) => event.type === "output")).toEqual([{ type: "output", chunk: "working" }])
    expect(events.filter((event) => event.type === "fileChange")).toEqual([
      { type: "fileChange", path: "new.ts", changeType: "add" },
      { type: "fileChange", path: "old.ts", changeType: "modify" },
    ])
    expect(events.find((event) => event.type === "complete")?.result.filesChanged).toEqual(["new.ts", "old.ts"])
  })

  it("does not allow subagent success or failure to finish the enclosing Actor", async () => {
    await run([
      { ...SUCCESS, parent_tool_use_id: "child", result: "child-only" },
      {
        type: "result",
        parent_tool_use_id: "child",
        subtype: "error_during_execution",
        is_error: true,
        error: { message: "child failure" },
      },
      { type: "assistant", message: { model: "parent-model", content: [] } },
      SUCCESS,
    ])
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1)
    expect(events.filter((event) => event.type === "error")).toHaveLength(0)
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage?.model).toBe("parent-model")
  })

  it("rejects structured native errors without disclosing raw auth details and retains observed usage", async () => {
    await run([
      {
        ...SUCCESS,
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        error: { message: "SECRET-auth-response" },
      },
    ])
    expect(events.filter((event) => event.type === "complete")).toHaveLength(0)
    expect(events.find((event) => event.type === "error")?.error).toMatchObject({
      code: "CRASH",
      recoverable: false,
      tokenUsage: { input: 100, output: 12, model: "qwen" },
    })
    expect(JSON.stringify(events)).not.toContain("SECRET-auth-response")
  })

  it.each([0, 1, 2])("requires a valid result and does not equate exit %s with successful work", async (code) => {
    await run([{ type: "system" }], code)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(events.some((event) => event.type === "error")).toBe(true)
  })

  it("a native process failure overrides an earlier success envelope", async () => {
    await run([SUCCESS], 1)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(events.find((event) => event.type === "error")?.error.tokenUsage?.input).toBe(100)
  })

  it.each([
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1.5, output_tokens: 2 },
    { input_tokens: "10", output_tokens: 2 },
    undefined,
  ])("keeps missing or malformed usage unknown", async (usage) => {
    await run([{ ...SUCCESS, usage }])
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toBeUndefined()
  })

  it("marks aggregate multi-model usage so cost routing cannot price it as one pinned model", async () => {
    await run([{ ...SUCCESS, modelUsage: { first: {}, second: {} } }], 0, { model: "first" })
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage?.model).toBe("qwen-mixed-models")
  })

  it("keeps observed child-model aggregate cost unknown even when modelUsage metadata is absent", async () => {
    await run([
      { type: "assistant", parent_tool_use_id: "child", message: { model: "child-model", content: [] } },
      { type: "assistant", message: { model: "parent-model", content: [] } },
      SUCCESS,
    ])
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage?.model).toBe("qwen-mixed-models")
  })

  it("ignores malformed prelude, drains stderr and preserves a valid terminal frame", async () => {
    fakeProcess([SUCCESS], 0, { stderr: true, prefix: "non-json diagnostic\n" })
    await session.start({ type: "qwen", timeout: 10, workspacePath: workspace })
    await session.execute("test")
    expect(events.some((event) => event.type === "complete")).toBe(true)
  })

  it("resets native model, result and changed paths across repeated executions", async () => {
    await run([
      { type: "system", model: "old-model" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "edit", input: { file_path: "old.ts" } }] } },
      SUCCESS,
    ])
    events.length = 0
    fakeProcess([SUCCESS])
    await session.execute("second")
    expect(events.find((event) => event.type === "complete")?.result).toMatchObject({
      filesChanged: [],
      tokenUsage: { model: "qwen" },
    })
  })

  it("fails closed when an OS sandbox plan is unavailable", async () => {
    vi.spyOn(sandbox, "planSandboxedSpawn").mockRejectedValue(new Error("No OS sandbox"))
    await session.start({ type: "qwen", workspacePath: workspace, timeout: 10 })
    await session.execute("test")
    expect(events.find((event) => event.type === "error")?.error.message).toContain("No OS sandbox")
    expect(session.pid).toBeUndefined()
  })

  it("cancels the native process and releases resources without a completed result", async () => {
    fakeProcess([{ type: "system" }], 0, { keepAlive: true })
    await session.start({ type: "qwen", workspacePath: workspace, timeout: 10 })
    const spawned = new Promise<void>((resolve) => session.on("spawned", () => resolve()))
    const execution = session.execute("test")
    await spawned
    expect(session.isAlive()).toBe(true)
    await session.cancel()
    await execution
    expect(session.isAlive()).toBe(false)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    await session.dispose()
    expect(session.pid).toBeUndefined()
    expect(session.isAlive()).toBe(false)
  })

  it("guards execution before start", async () => {
    expect(session.isAlive()).toBe(false)
    await session.execute("test")
    expect(events.find((event) => event.type === "error")?.error.message).toContain("before start")
  })
})
