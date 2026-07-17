/**
 * KimiSession tests — invocation flags (incl. that --skills-dir is NEVER
 * passed, since kimi already auto-discovers .agents/skills and the flag
 * would replace rather than add to that auto-discovery, and the hard
 * "never --yolo/--auto" constraint), NDJSON stream parsing (claude-shaped
 * primary path + flat fallback), token usage extraction, streaming/OOM-bound
 * output, sandbox wrapping, timeout classification, and the "No model
 * configured" unauth -> AUTH_FAILED path.
 *
 * Uses a mock `kimi` script on PATH emitting stream-json NDJSON (or plain
 * text, for the unauth case) — no real kimi binary is required or invoked.
 * The NDJSON event schema exercised here is UNVERIFIED against a real
 * authenticated kimi run — see the module doc comment in kimi-session.ts.
 */

import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import * as sandboxModule from "./sandbox"

const MOCK_DIR = resolve(tmpdir(), "av-test-kimi-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "kimi")
const ARGV_LOG = resolve(MOCK_DIR, "argv.log")
const WORKSPACE_DIR = resolve(tmpdir(), "av-test-kimi-workspace")

function writeMockKimi(ndjsonLines: string[]): void {
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

function writeMockKimiRaw(script: string): void {
  mkdirSync(MOCK_DIR, { recursive: true })
  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

function readArgvLog(): string[] {
  const { readFileSync } = require("node:fs")
  const raw: string = readFileSync(ARGV_LOG, "utf-8")
  return raw.split("\n").filter((l) => l.length > 0)
}

/** Claude-shaped assistant event with nested message.content blocks (primary, unverified parse path). */
function assistantTextEvent(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })
}

function assistantToolUseEvent(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  })
}

describe("KimiSession", () => {
  let originalPath: string

  beforeEach(() => {
    originalPath = process.env.PATH ?? ""
    process.env.PATH = `${MOCK_DIR}:${originalPath}`
    mkdirSync(WORKSPACE_DIR, { recursive: true })
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
    try {
      rmSync(WORKSPACE_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test("invokes kimi with -p <prompt> --output-format stream-json, routes through planSandboxedSpawn, and never passes --yolo/--auto", async () => {
    writeMockKimi([JSON.stringify({ type: "result", result: "done", is_error: false, duration_ms: 10 })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR, model: "k2-thinking" })
    await session.execute("test prompt")

    expect(sandboxModule.planSandboxedSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "kimi",
        command: "kimi",
        workspacePath: WORKSPACE_DIR,
      }),
    )

    const argv = readArgvLog()
    expect(argv).toContain("-p")
    expect(argv).toContain("test prompt")
    expect(argv).toContain("--output-format")
    expect(argv).toContain("stream-json")
    expect(argv).toContain("--model")
    expect(argv).toContain("k2-thinking")
    // Hard constraint: kimi refuses to start if -p is combined with an
    // auto-approve flag ("Cannot combine --prompt with --yolo/--auto").
    expect(argv).not.toContain("--yolo")
    expect(argv).not.toContain("--auto")
    // --skills-dir is deliberately never passed — see the dedicated tests
    // below and the module doc comment (kimi auto-discovers .agents/skills;
    // the flag would replace, not add to, that auto-discovery).
    expect(argv).not.toContain("--skills-dir")
  })

  test("never passes --skills-dir, even when the workspace has .agents/skills (kimi auto-discovers it; the flag would replace auto-discovery, not add to it)", async () => {
    const skillsDir = resolve(WORKSPACE_DIR, ".agents", "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeMockKimi([JSON.stringify({ type: "result", result: "done", is_error: false })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    const argv = readArgvLog()
    expect(argv).not.toContain("--skills-dir")
  })

  test("never passes --skills-dir when .agents/skills does not exist either", async () => {
    writeMockKimi([JSON.stringify({ type: "result", result: "done", is_error: false })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    const argv = readArgvLog()
    expect(argv).not.toContain("--skills-dir")
  })

  test("streams claude-shaped assistant text and completes with the result event's text", async () => {
    writeMockKimi([
      assistantTextEvent("Hello "),
      assistantTextEvent("World"),
      JSON.stringify({ type: "result", is_error: false, result: "Final summary", duration_ms: 1000 }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    const chunks: string[] = []
    let completed: AgentEvent | null = null

    session.on("output", (e) => chunks.push(e.chunk))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test prompt")

    expect(chunks).toEqual(["Hello ", "World"])
    expect(completed).not.toBeNull()
    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("Final summary")
  })

  test("parses a flat fallback shape (text/content/delta) for schema drift", async () => {
    writeMockKimi([
      JSON.stringify({ type: "assistant", text: "flat chunk" }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    const chunks: string[] = []
    session.on("output", (e) => chunks.push(e.chunk))

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(chunks).toEqual(["flat chunk"])
  })

  test("does not OOM with large streamed output", async () => {
    const bigChunk = "x".repeat(1024)
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(assistantTextEvent(bigChunk))
    }
    lines.push(JSON.stringify({ type: "result", result: "done", is_error: false, duration_ms: 5000 }))

    writeMockKimi(lines)

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let chunkCount = 0
    let completed = false

    session.on("output", () => chunkCount++)
    session.on("complete", () => {
      completed = true
    })

    await session.start({ type: "kimi", timeout: 60, workspacePath: WORKSPACE_DIR })

    const memBefore = process.memoryUsage().heapUsed
    await session.execute("test prompt")
    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)

    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50)
  })

  test("emits tool use and file change events from claude-shaped tool_use content blocks", async () => {
    writeMockKimi([
      assistantToolUseEvent("write", { file_path: "/tmp/foo.ts" }),
      assistantToolUseEvent("edit", { file_path: "/tmp/bar.ts" }),
      assistantToolUseEvent("read", { file_path: "/tmp/baz.ts" }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(tools).toEqual(["write", "edit", "read"])
    expect(files).toEqual([
      { path: "/tmp/foo.ts", changeType: "add" },
      { path: "/tmp/bar.ts", changeType: "modify" },
    ])
  })

  test("also handles the top-level tool_use/tool_call fallback shape for schema drift", async () => {
    writeMockKimi([
      JSON.stringify({ type: "tool_call", name: "write", args: { file_path: "/tmp/foo.ts" } }),
      JSON.stringify({ type: "result", result: "done", is_error: false }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    const tools: string[] = []
    session.on("toolUse", (e) => tools.push(e.tool))

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(tools).toEqual(["write"])
  })

  test("emits error on is_error result", async () => {
    writeMockKimi([JSON.stringify({ type: "result", result: "something went wrong", is_error: true })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(error).not.toBeNull()
    expect((error as unknown as { error: { message: string } }).error.message).toBe("something went wrong")
  })

  test("extracts tokenUsage from snake_case usage fields (including cache tokens)", async () => {
    writeMockKimi([
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "done",
        model: "k2-thinking",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(tokenUsage).toEqual({ input: 1150, output: 500, model: "k2-thinking" })
  })

  test("falls back to camelCase usage fields and config.model for schema drift", async () => {
    writeMockKimi([
      JSON.stringify({
        type: "result",
        result: "done",
        is_error: false,
        usage: { inputTokens: 1000, outputTokens: 500 },
      }),
    ])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR, model: "k2-thinking" })
    await session.execute("test")

    expect(tokenUsage).toEqual({ input: 1000, output: 500, model: "k2-thinking" })
  })

  test("result without usage leaves tokenUsage undefined", async () => {
    writeMockKimi([JSON.stringify({ type: "result", result: "done", is_error: false })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let tokenUsage: unknown = "unset"
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(tokenUsage).toBeUndefined()
  })

  test("result output is capped at 10KB", async () => {
    const bigResult = "y".repeat(20_000)
    writeMockKimi([JSON.stringify({ type: "result", result: bigResult, is_error: false, duration_ms: 100 })])

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let output = ""
    session.on("complete", (e) => {
      output = e.result.output
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(output.length).toBe(10240)
  })

  test('detects "No model configured" (plain text, non-JSON) and surfaces an actionable AUTH_FAILED error', async () => {
    writeMockKimiRaw(`#!/bin/bash
echo "No model configured" >&2
exit 1
`)

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string; recoverable: boolean } }).error
    expect(err.code).toBe("AUTH_FAILED")
    expect(err.message).toContain("kimi")
    expect(err.message).toContain("/login")
    expect(err.recoverable).toBe(false)
  })

  test("classifies a non-zero exit code without the unauth message as a recoverable CRASH", async () => {
    writeMockKimiRaw(`#!/bin/bash
exit 1
`)

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("exited with code 1")
  })

  test("classifies a killed process (null exit code) as TIMEOUT", async () => {
    // `exec` replaces the bash process image with `sleep` (same PID) instead
    // of forking a child — otherwise SIGKILL only terminates bash and the
    // orphaned `sleep` child keeps the stdout pipe open, so "close" never
    // fires within the test timeout.
    writeMockKimiRaw(`#!/bin/bash
exec sleep 5
`)

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    const execPromise = session.execute("test")

    await new Promise((r) => setTimeout(r, 300))
    await session.kill()
    await execPromise

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string } }).error
    expect(err.code).toBe("TIMEOUT")
  })

  test("execute() before start() emits a non-recoverable CRASH error", async () => {
    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.execute("test")

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.recoverable).toBe(false)
  })
})

describe("KimiSession — sandbox wrapping", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      unlinkSync(MOCK_SCRIPT)
    } catch {
      // ignore
    }
    try {
      rmSync(WORKSPACE_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test("routes every spawn through planSandboxedSpawn with agentType 'kimi' and the built argv", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    writeMockKimiRaw("#!/bin/bash\nexit 0\n")

    const planSandboxedSpawn = vi.spyOn(sandboxModule, "planSandboxedSpawn").mockResolvedValue({
      command: MOCK_SCRIPT,
      args: [],
      sandboxed: true,
      platform: "darwin" as NodeJS.Platform,
      networkAllowlist: [],
    })

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    const call = planSandboxedSpawn.mock.calls[0]?.[0] as {
      agentType: string
      command: string
      args: string[]
      workspacePath: string
    }
    expect(call.agentType).toBe("kimi")
    expect(call.command).toBe("kimi")
    expect(call.workspacePath).toBe(WORKSPACE_DIR)
    expect(call.args).toContain("-p")
    expect(call.args).toContain("hello")
  })

  test("propagates a fail-closed sandbox rejection as a non-recoverable CRASH error without spawning", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    const planSandboxedSpawn = vi
      .spyOn(sandboxModule, "planSandboxedSpawn")
      .mockRejectedValue(new Error('sessions/sandbox: no OS sandbox available for agent "kimi"'))

    const { KimiSession } = await import("./kimi-session")
    const session = new KimiSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "kimi", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.recoverable).toBe(false)
  })
})
