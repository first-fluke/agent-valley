import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import * as sandbox from "./sandbox"
import { ZcodeSession } from "./zcode-session"

const SUCCESS = {
  type: "result",
  sessionId: "sess_fixture",
  response: "done",
  projection: { status: "idle", turnCount: 1 },
  usage: { source: "provider", inputTokens: 100, outputTokens: 12, cacheReadTokens: 80 },
}
let workspace: string
let session: ZcodeSession
let events: AgentEvent[]

function fakeProcess(frames: unknown[], exitCode = 0, stderr = "", keepAlive = false) {
  const stderrExpression =
    stderr.length > 8192 ? `"x".repeat(1048576) + ${JSON.stringify(stderr.slice(-4096))}` : JSON.stringify(stderr)
  const script = `${keepAlive ? 'process.on("SIGTERM", () => process.exit(0));' : ""} process.stdout.write(${JSON.stringify(frames.map((frame) => JSON.stringify(frame)).join("\n"))}); process.stderr.write(${stderrExpression}); ${keepAlive ? "setInterval(() => {}, 1000)" : `process.exitCode = ${exitCode}`}`
  vi.spyOn(sandbox, "planSandboxedSpawn").mockResolvedValue({
    command: process.execPath,
    args: ["-e", script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
}

async function run(frames: unknown[], code = 0, stderr = "") {
  fakeProcess(frames, code, stderr)
  await session.start({ type: "zcode", workspacePath: workspace, timeout: 10 })
  await session.execute("operator prompt $(literal)\nnext line")
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "av-zcode-session-"))
  session = new ZcodeSession()
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

describe("ZCode native prompt protocol", () => {
  it("uses native prompt argv and flushes an unterminated result with cache-inclusive usage", async () => {
    await run([{ type: "session.updated", payload: { providerId: "zai", modelId: "glm" } }, SUCCESS])
    expect(sandbox.planSandboxedSpawn).toHaveBeenCalledWith({
      agentType: "zcode",
      command: "zcode",
      args: [
        "--prompt",
        "operator prompt $(literal)\nnext line",
        "--mode",
        "yolo",
        "--output-format",
        "stream-json",
        "--no-color",
      ],
      workspacePath: workspace,
      env: expect.any(Object),
    })
    expect(events.find((event) => event.type === "complete")?.result).toMatchObject({
      output: "done",
      tokenUsage: { input: 100, output: 12, model: "glm" },
    })
    expect(session.isAlive()).toBe(false)
  })

  it("keeps nested model aggregate identity unknown despite an observed main model", async () => {
    // Native emitNestedModelUsageEvents emits ModelComplete(stopReason:tool_internal)
    // without modelId; session-mapper maps it to session.updated unchanged.
    await run([
      { type: "session.updated", payload: { providerId: "zai", modelId: "glm" } },
      {
        type: "session.updated",
        payload: {
          content: "",
          stopReason: "tool_internal",
          usage: { inputTokens: 20, outputTokens: 2 },
          toolCallCount: 0,
        },
      },
      SUCCESS,
    ])
    expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toEqual({
      input: 100,
      output: 12,
      model: "zcode-mixed-or-unknown",
    })
  })

  it.each([undefined, "estimated", "unknown"])(
    "does not report usage with a non-provider source (%j)",
    async (source) => {
      await run([{ ...SUCCESS, usage: { ...SUCCESS.usage, source } }])
      expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toBeUndefined()
    },
  )

  it("emits native text and records only successful file mutations", async () => {
    await run([
      { type: "model.streaming", payload: { kind: "text_delta", delta: "working" } },
      {
        type: "tool.updated",
        payload: { kind: "scheduled", toolCallId: "w", toolName: "Write", input: { file_path: "ok.ts" } },
      },
      { type: "tool.updated", payload: { kind: "result", toolCallId: "w", result: { success: true } } },
      {
        type: "tool.updated",
        payload: { kind: "scheduled", toolCallId: "e", toolName: "Edit", input: { file_path: "failed.ts" } },
      },
      { type: "tool.updated", payload: { kind: "result", toolCallId: "e", result: { success: false } } },
      { type: "turn.completed", payload: { resultType: "success" } },
      SUCCESS,
    ])
    expect(events.filter((event) => event.type === "output")).toEqual([{ type: "output", chunk: "working" }])
    expect(events.filter((event) => event.type === "toolUse")).toHaveLength(2)
    expect(events.find((event) => event.type === "complete")?.result.filesChanged).toEqual(["ok.ts"])
  })

  it.each([0, 1, 2])("does not turn exit %s without a valid result into success", async (code) => {
    await run([{ type: "turn.completed", payload: { resultType: "success" } }], code)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(events.some((event) => event.type === "error")).toBe(true)
  })

  it("requires successful process exit even after a result", async () => {
    await run([SUCCESS], 1)
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(events.find((event) => event.type === "error")?.error.tokenUsage?.input).toBe(100)
  })

  it("rejects duplicate terminal envelopes", async () => {
    await run([SUCCESS, SUCCESS])
    expect(events.some((event) => event.type === "complete")).toBe(false)
  })

  it("ignores results belonging to another observed session", async () => {
    await run([{ type: "session.created", sessionId: "own" }, SUCCESS])
    expect(events.some((event) => event.type === "complete")).toBe(false)
  })

  it.each(["cancelled", "error_max_budget", "error_max_turns", "error_during_execution"])(
    "rejects native turn result %s",
    async (resultType) => {
      await run([{ type: "turn.completed", payload: { resultType } }, SUCCESS])
      expect(events.some((event) => event.type === "complete")).toBe(false)
    },
  )

  it("classifies exhaustion from native errors without leaking auth responses", async () => {
    await run([{ type: "turn.failed", payload: { error: { message: "context_length_exceeded SECRET" } } }, SUCCESS])
    expect(events.find((event) => event.type === "error")?.error.message).toContain("context_length_exceeded")
    expect(JSON.stringify(events)).not.toContain("SECRET")
  })

  it("drains stderr and classifies an unstructured exhaustion error", async () => {
    await run([], 1, `${"x".repeat(1_048_576)}\ncontext_length_exceeded`)
    expect(events.find((event) => event.type === "error")?.error.message).toContain("context_length_exceeded")
  })

  it.each([undefined, { inputTokens: -1, outputTokens: 12 }, { inputTokens: "100", outputTokens: 12 }])(
    "keeps unknown usage unknown",
    async (usage) => {
      await run([{ ...SUCCESS, usage }])
      expect(events.find((event) => event.type === "complete")?.result.tokenUsage).toBeUndefined()
    },
  )

  it("rejects per-run model overrides with native configuration instructions", async () => {
    await session.start({ type: "zcode", model: "fake-model", workspacePath: workspace, timeout: 10 })
    await session.execute("prompt")
    expect(events.find((event) => event.type === "error")?.error.message).toContain("defaultModelSelection")
    expect(session.pid).toBeUndefined()
  })

  it("cancels the process and joins cleanup without a successful result", async () => {
    fakeProcess([{ type: "model.streaming", payload: { kind: "text_delta", delta: "running" } }], 0, "", true)
    await session.start({ type: "zcode", workspacePath: workspace, timeout: 10 })
    const spawned = new Promise<void>((resolve) => session.on("spawned", () => resolve()))
    const execution = session.execute("prompt")
    await spawned
    await session.cancel()
    await execution
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(session.isAlive()).toBe(false)
  })

  it("does not complete after cancellation when native SIGTERM exits zero after a buffered result", async () => {
    fakeProcess([{ type: "model.streaming", payload: { kind: "text_delta", delta: "ready" } }, SUCCESS], 0, "", true)
    await session.start({ type: "zcode", workspacePath: workspace, timeout: 10 })
    const ready = new Promise<void>((resolve) => session.on("output", () => resolve()))
    const execution = session.execute("prompt")
    await ready
    await session.cancel()
    await execution
    expect(events.some((event) => event.type === "complete")).toBe(false)
    expect(session.isAlive()).toBe(false)
  })

  it("guards execution before start", async () => {
    expect(session.isAlive()).toBe(false)
    await session.execute("prompt")
    expect(events.find((event) => event.type === "error")?.error.message).toContain("before start")
  })
})
