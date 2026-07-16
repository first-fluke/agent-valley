/**
 * CursorSession tests — verifies invocation flags, NDJSON stream parsing
 * (result + token usage extraction), streaming/OOM-bound output, sandbox
 * wrapping, and prompt-length guarding.
 *
 * The `system`/`init` and `user` event shapes below are the CONFIRMED live
 * wire format (captured by a teammate running the real `cursor-agent`
 * binary — see cursor-session.ts module docstring). `assistant`/`result`/
 * `usage` are claude-parity, high-confidence but not directly observed;
 * tests for those primarily exercise the claude-shaped fields, with
 * separate tests covering the tolerant fallback aliases kept for schema
 * drift.
 *
 * Uses a mock `cursor-agent` script on PATH emitting stream-json NDJSON —
 * no real cursor-agent binary is required or invoked.
 */

import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import * as sandboxModule from "./sandbox"

const MOCK_DIR = resolve(tmpdir(), "av-test-cursor-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "cursor-agent")
const ARGV_LOG = resolve(MOCK_DIR, "argv.log")

function writeMockCursorAgent(ndjsonLines: string[]): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  // Script logs its argv (one per line) then emits NDJSON to stdout.
  const script = [
    "#!/bin/bash",
    `printf '%s\\n' "$@" > "${ARGV_LOG}"`,
    ...ndjsonLines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`),
    "exit 0",
  ].join("\n")

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

function readArgvLog(): string[] {
  const { readFileSync } = require("node:fs")
  const raw: string = readFileSync(ARGV_LOG, "utf-8")
  return raw.split("\n").filter((l) => l.length > 0)
}

/** Confirmed-live system/init event, with an optional model override. */
function systemInitEvent(model = "Fable 5 300K High"): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/private/tmp/vendor-probe",
    session_id: "6de0194a-test",
    model,
    permissionMode: "default",
  })
}

/** Confirmed-live user echo event. */
function userEvent(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    session_id: "6de0194a-test",
  })
}

/** Claude-parity assistant event with nested message.content blocks. */
function assistantTextEvent(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "6de0194a-test",
  })
}

/** Claude-parity assistant event carrying a tool_use content block. */
function assistantToolUseEvent(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
    session_id: "6de0194a-test",
  })
}

describe("CursorSession", () => {
  let originalPath: string

  beforeEach(() => {
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${MOCK_DIR}:${originalPath}`
    // Force a deterministic, non-sandboxed spawn plan so tests don't depend
    // on the host actually having sandbox-exec/bwrap installed — mirrors
    // sandbox.test.ts's own approach of exercising planSandboxedSpawn
    // directly, but here we stub it since ownership of sandbox.ts stays
    // with the sandbox module's own tests.
    vi.spyOn(sandboxModule, "planSandboxedSpawn").mockImplementation(async (req) => ({
      command: req.command,
      args: req.args,
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    }))
  })

  afterEach(() => {
    process.env.PATH = originalPath
    vi.restoreAllMocks()
    try {
      unlinkSync(MOCK_SCRIPT)
    } catch {
      // ignore
    }
    try {
      unlinkSync(ARGV_LOG)
    } catch {
      // ignore
    }
  })

  test("invokes cursor-agent with the expected flags and routes through planSandboxedSpawn", async () => {
    writeMockCursorAgent([JSON.stringify({ type: "result", result: "done", is_error: false, duration_ms: 10 })])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp", model: "sonnet-4-thinking" })
    await session.execute("test prompt")

    expect(sandboxModule.planSandboxedSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "cursor",
        command: "cursor-agent",
        workspacePath: "/tmp",
      }),
    )

    const argv = readArgvLog()
    expect(argv).toContain("-p")
    expect(argv).toContain("--output-format")
    expect(argv).toContain("stream-json")
    expect(argv).toContain("--stream-partial-output")
    // --force is REQUIRED for non-interactive use (bypasses the
    // "Workspace Trust Required" prompt), not merely a permission-bypass
    // convenience — confirmed by a live run.
    expect(argv).toContain("--force")
    expect(argv).toContain("--model")
    expect(argv).toContain("sonnet-4-thinking")
    // Prompt passed as a trailing positional argv element (stdin support
    // unconfirmed — see cursor-session.ts module docstring).
    expect(argv).toContain("test prompt")
  })

  test("captures model from the confirmed system/init event and streams assistant text (claude-parity shape)", async () => {
    writeMockCursorAgent([
      systemInitEvent("Fable 5 300K High"),
      userEvent("test prompt"),
      assistantTextEvent("Hello "),
      assistantTextEvent("World"),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Final summary",
        duration_ms: 1000,
      }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    const chunks: string[] = []
    const heartbeats: AgentEvent[] = []
    let completed: AgentEvent | null = null

    session.on("output", (e) => chunks.push(e.chunk))
    session.on("heartbeat", (e) => heartbeats.push(e))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test prompt")

    expect(chunks).toEqual(["Hello ", "World"])
    // system/init + user both map to heartbeat (no textual content of
    // their own to surface as agent output).
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)

    expect(completed).not.toBeNull()
    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("Final summary")
  })

  test("parses a flat fallback shape (text/content/delta) for schema drift", async () => {
    writeMockCursorAgent([
      JSON.stringify({ type: "assistant", text: "flat chunk" }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    const chunks: string[] = []
    session.on("output", (e) => chunks.push(e.chunk))

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(chunks).toEqual(["flat chunk"])
  })

  test("does not OOM with large output", async () => {
    const bigChunk = "x".repeat(1024)
    const lines: string[] = [systemInitEvent()]
    for (let i = 0; i < 1000; i++) {
      lines.push(assistantTextEvent(bigChunk))
    }
    lines.push(JSON.stringify({ type: "result", result: "done", is_error: false, duration_ms: 5000 }))

    writeMockCursorAgent(lines)

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let chunkCount = 0
    let completed = false

    session.on("output", () => chunkCount++)
    session.on("complete", () => {
      completed = true
    })

    await session.start({ type: "cursor", timeout: 60, workspacePath: "/tmp" })

    const memBefore = process.memoryUsage().heapUsed
    await session.execute("test prompt")
    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)

    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50)
  })

  test("emits tool use and file change events from claude-shaped tool_use content blocks", async () => {
    writeMockCursorAgent([
      assistantToolUseEvent("write", { file_path: "/tmp/foo.ts" }),
      assistantToolUseEvent("edit", { file_path: "/tmp/bar.ts" }),
      assistantToolUseEvent("read", { file_path: "/tmp/baz.ts" }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tools).toEqual(["write", "edit", "read"])
    expect(files).toEqual([
      { path: "/tmp/foo.ts", changeType: "add" },
      { path: "/tmp/bar.ts", changeType: "modify" },
    ])
  })

  test("also handles the top-level tool_call fallback shape for schema drift", async () => {
    writeMockCursorAgent([
      JSON.stringify({ type: "tool_call", name: "write", args: { file_path: "/tmp/foo.ts" } }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tools).toEqual(["write"])
    expect(files).toEqual([{ path: "/tmp/foo.ts", changeType: "add" }])
  })

  test("emits error on is_error result", async () => {
    writeMockCursorAgent([JSON.stringify({ type: "result", result: "something went wrong", is_error: true })])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(error).not.toBeNull()
    expect((error as unknown as { error: { message: string } }).error.message).toBe("something went wrong")
  })

  test("extracts tokenUsage from claude-parity snake_case usage fields (including cache tokens), model from system/init", async () => {
    writeMockCursorAgent([
      systemInitEvent("Fable 5 300K High"),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tokenUsage).toEqual({
      input: 1150,
      output: 500,
      // Model is not repeated on the result event — sourced from the
      // system/init event's `model` field.
      model: "Fable 5 300K High",
    })
  })

  test("falls back to camelCase usage fields for schema drift", async () => {
    writeMockCursorAgent([
      JSON.stringify({
        type: "result",
        result: "done",
        is_error: false,
        model: "sonnet-4-thinking",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 100,
          cacheCreationTokens: 50,
        },
      }),
    ])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp", model: "sonnet-4-thinking" })
    await session.execute("test")

    expect(tokenUsage).toEqual({
      input: 1150,
      output: 500,
      model: "sonnet-4-thinking",
    })
  })

  test("result without usage leaves tokenUsage undefined", async () => {
    writeMockCursorAgent([JSON.stringify({ type: "result", result: "done", is_error: false })])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let tokenUsage: unknown = "unset"
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tokenUsage).toBeUndefined()
  })

  test("result output is capped at 10KB", async () => {
    const bigResult = "y".repeat(20_000)
    writeMockCursorAgent([JSON.stringify({ type: "result", result: bigResult, is_error: false, duration_ms: 100 })])

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let output = ""
    session.on("complete", (e) => {
      output = e.result.output
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(output.length).toBe(10240)
  })

  test("rejects prompts exceeding MAX_PROMPT_ARG_LENGTH with an actionable error, without spawning", async () => {
    const { CursorSession, MAX_PROMPT_ARG_LENGTH } = await import("./cursor-session")
    const session = new CursorSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("x".repeat(MAX_PROMPT_ARG_LENGTH + 1))

    expect(error).not.toBeNull()
    const errEvent = (error as unknown as { error: { message: string; recoverable: boolean } }).error
    expect(errEvent.message).toContain("MAX_PROMPT_ARG_LENGTH")
    expect(errEvent.recoverable).toBe(false)
    expect(sandboxModule.planSandboxedSpawn).not.toHaveBeenCalled()
  })

  test("propagates fail-closed sandbox rejection as a non-recoverable CRASH", async () => {
    writeMockCursorAgent([JSON.stringify({ type: "result", result: "done", is_error: false })])

    vi.spyOn(sandboxModule, "planSandboxedSpawn").mockRejectedValue(
      new Error('sessions/sandbox: no OS sandbox available for agent "cursor"'),
    )

    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "cursor", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(error).not.toBeNull()
    const errEvent = (error as unknown as { error: { code: string; recoverable: boolean } }).error
    expect(errEvent.code).toBe("CRASH")
    expect(errEvent.recoverable).toBe(false)
  })

  test("execute() before start() emits a non-recoverable CRASH error", async () => {
    const { CursorSession } = await import("./cursor-session")
    const session = new CursorSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.execute("test")

    expect(error).not.toBeNull()
    expect((error as unknown as { error: { code: string } }).error.code).toBe("CRASH")
  })
})
