/**
 * OpencodeSession tests — invocation flags (`run`, `--format json`,
 * `--auto`, NO `--pure`, positional prompt), NDJSON stream parsing
 * (confirmed `step-start`/`tool_use`/`tool` types + tolerant fallback for
 * unconfirmed event/terminal shapes), token usage extraction (best-effort),
 * streaming/OOM-bound output, sandbox wrapping, timeout classification, and
 * the unauthenticated -> AUTH_FAILED path.
 *
 * Uses a mock `opencode` script on PATH emitting NDJSON matching the real
 * v1.17.18 capture's confirmed event types — no real opencode binary is
 * required or invoked. See the module doc comment in opencode-session.ts
 * for exactly which parts of the schema are confirmed vs. tolerant
 * best-effort.
 */

import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentEvent } from "./agent-session"
import * as sandboxModule from "./sandbox"

const MOCK_DIR = resolve(tmpdir(), "av-test-opencode-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "opencode")
const ARGV_LOG = resolve(MOCK_DIR, "argv.log")
const WORKSPACE_DIR = resolve(tmpdir(), "av-test-opencode-workspace")

function writeMockOpencode(ndjsonLines: string[]): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  const script = [
    "#!/bin/bash",
    `printf '%s\\n' "$@" > "${ARGV_LOG}"`,
    ...ndjsonLines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`),
    "exit 0",
  ].join("\n")

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

function writeMockOpencodeRaw(script: string): void {
  mkdirSync(MOCK_DIR, { recursive: true })
  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

function readArgvLog(): string[] {
  const { readFileSync } = require("node:fs")
  const raw: string = readFileSync(ARGV_LOG, "utf-8")
  return raw.split("\n").filter((l) => l.length > 0)
}

describe("OpencodeSession", () => {
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

  test("invokes opencode with run <prompt> --format json --auto, prompt as trailing positional, and NEVER passes --pure", async () => {
    writeMockOpencode([JSON.stringify({ type: "step-start" })])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    await session.start({
      type: "opencode",
      timeout: 30,
      workspacePath: WORKSPACE_DIR,
      model: "anthropic/claude-sonnet-5",
    })
    await session.execute("test prompt")

    expect(sandboxModule.planSandboxedSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "opencode",
        command: "opencode",
        workspacePath: WORKSPACE_DIR,
      }),
    )

    const argv = readArgvLog()
    expect(argv[0]).toBe("run")
    expect(argv).toContain("test prompt")
    expect(argv).toContain("--format")
    expect(argv).toContain("json")
    expect(argv).toContain("--auto")
    expect(argv).toContain("--model")
    expect(argv).toContain("anthropic/claude-sonnet-5")
    expect(argv).not.toContain("--pure")
  })

  test("omits --model when config.model is not set", async () => {
    writeMockOpencode([JSON.stringify({ type: "step-start" })])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    const argv = readArgvLog()
    expect(argv).not.toContain("--model")
  })

  test("rejects a prompt exceeding MAX_PROMPT_ARG_LENGTH with a non-recoverable CRASH before spawning", async () => {
    const { OpencodeSession, MAX_PROMPT_ARG_LENGTH } = await import("./opencode-session")
    const session = new OpencodeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("x".repeat(MAX_PROMPT_ARG_LENGTH + 1))

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("MAX_PROMPT_ARG_LENGTH")
    expect(err.recoverable).toBe(false)
    expect(sandboxModule.planSandboxedSpawn).not.toHaveBeenCalled()
  })

  test("treats step-start and step_start as heartbeats (both spellings observed in the live capture)", async () => {
    writeMockOpencode([JSON.stringify({ type: "step-start" }), JSON.stringify({ type: "step_start" })])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    const heartbeats: AgentEvent[] = []
    session.on("heartbeat", (e) => heartbeats.push(e))

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(heartbeats.length).toBe(2)
  })

  test("emits toolUse and fileChange for tool_use events matching write/edit hints (real trigger from the live capture — the oma-backend Skill)", async () => {
    writeMockOpencode([
      JSON.stringify({ type: "tool_use", name: "write_file", input: { file_path: "/tmp/foo.ts" } }),
      JSON.stringify({ type: "tool_use", name: "edit_file", input: { file_path: "/tmp/bar.ts" } }),
      JSON.stringify({ type: "tool_use", name: "skill", input: { name: "oma-backend" } }),
      JSON.stringify({ type: "step-start" }),
    ])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(tools).toEqual(["write_file", "edit_file", "skill"])
    expect(files).toEqual([
      { path: "/tmp/foo.ts", changeType: "add" },
      { path: "/tmp/bar.ts", changeType: "modify" },
    ])
  })

  test("parses tool_use input given as a JSON-encoded string", async () => {
    writeMockOpencode([
      JSON.stringify({ type: "tool_use", name: "write", input: JSON.stringify({ file_path: "/tmp/a.ts" }) }),
    ])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    const files: Array<{ path: string }> = []
    session.on("fileChange", (e) => files.push({ path: e.path }))

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(files).toEqual([{ path: "/tmp/a.ts" }])
  })

  test("'tool' event: heartbeat by default, streams text when a string output/result/text field is present (payload shape unconfirmed)", async () => {
    writeMockOpencode([
      JSON.stringify({ type: "tool", output: "tool result text" }),
      JSON.stringify({ type: "tool", ok: true }),
    ])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    const chunks: string[] = []
    const heartbeats: AgentEvent[] = []
    session.on("output", (e) => chunks.push(e.chunk))
    session.on("heartbeat", (e) => heartbeats.push(e))

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(chunks).toEqual(["tool result text"])
    expect(heartbeats.length).toBe(1)
  })

  test("falls back to flat text/content/delta/data fields for unconfirmed event types and accumulates into RunResult.output on process exit", async () => {
    writeMockOpencode([
      JSON.stringify({ type: "assistant-text", text: "Hello " }),
      JSON.stringify({ type: "assistant-text", content: "World" }),
    ])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    const chunks: string[] = []
    let completed: AgentEvent | null = null
    session.on("output", (e) => chunks.push(e.chunk))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(chunks).toEqual(["Hello ", "World"])
    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("Hello World")
  })

  test("an unconfirmed terminal-shaped event's result/usage text takes priority over the accumulated tail (best-effort, opportunistic)", async () => {
    writeMockOpencode([
      JSON.stringify({ type: "assistant-text", text: "streamed chunk" }),
      JSON.stringify({
        type: "result",
        result: "final answer text",
        model: "anthropic/claude-sonnet-5",
        usage: { input_tokens: 120, output_tokens: 45 },
      }),
    ])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let completed: AgentEvent | null = null
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    const result = (
      completed as unknown as {
        result: { output: string; tokenUsage?: { input: number; output: number; model: string } }
      }
    ).result
    expect(result.output).toBe("final answer text")
    expect(result.tokenUsage).toEqual({ input: 120, output: 45, model: "anthropic/claude-sonnet-5" })
  })

  test("tokenUsage is undefined when no terminal-shaped event with usage is seen", async () => {
    writeMockOpencode([JSON.stringify({ type: "step-start" })])

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let completed: AgentEvent | null = null
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    const result = (completed as unknown as { result: { tokenUsage?: unknown } }).result
    expect(result.tokenUsage).toBeUndefined()
  })

  test("does not OOM with large streamed output (bounded tail, not full accumulation)", async () => {
    const bigChunk = "x".repeat(1024)
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({ type: "assistant-text", text: bigChunk }))
    }
    writeMockOpencode(lines)

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let chunkCount = 0
    let completed = false
    let finalOutputLength = 0

    session.on("output", () => chunkCount++)
    session.on("complete", (e) => {
      completed = true
      finalOutputLength = e.result.output.length
    })

    await session.start({ type: "opencode", timeout: 60, workspacePath: WORKSPACE_DIR })

    const memBefore = process.memoryUsage().heapUsed
    await session.execute("test prompt")
    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)
    expect(finalOutputLength).toBeLessThanOrEqual(10 * 1024)

    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50)
  })

  test('detects an unauthenticated/no-provider error and surfaces an actionable AUTH_FAILED naming "opencode auth"', async () => {
    writeMockOpencodeRaw(`#!/bin/bash
echo "Error: not authenticated. Run opencode auth to configure a provider." >&2
exit 1
`)

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("test")

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string; recoverable: boolean } }).error
    expect(err.code).toBe("AUTH_FAILED")
    expect(err.message).toContain("opencode auth")
    expect(err.recoverable).toBe(false)
  })

  test("classifies a non-zero exit code without an auth-failure message as a recoverable CRASH", async () => {
    writeMockOpencodeRaw(`#!/bin/bash
exit 1
`)

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
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
    writeMockOpencodeRaw(`#!/bin/bash
exec sleep 5
`)

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    const execPromise = session.execute("test")

    await new Promise((r) => setTimeout(r, 300))
    await session.kill()
    await execPromise

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string } }).error
    expect(err.code).toBe("TIMEOUT")
  })

  test("execute() before start() emits a non-recoverable CRASH error", async () => {
    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

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

describe("OpencodeSession — sandbox wrapping", () => {
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

  test("routes every spawn through planSandboxedSpawn with agentType 'opencode' and the built argv", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    writeMockOpencodeRaw("#!/bin/bash\nexit 0\n")

    const planSandboxedSpawn = vi.spyOn(sandboxModule, "planSandboxedSpawn").mockResolvedValue({
      command: MOCK_SCRIPT,
      args: [],
      sandboxed: true,
      platform: "darwin" as NodeJS.Platform,
      networkAllowlist: [],
    })

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    const call = planSandboxedSpawn.mock.calls[0]?.[0] as {
      agentType: string
      command: string
      args: string[]
      workspacePath: string
    }
    expect(call.agentType).toBe("opencode")
    expect(call.command).toBe("opencode")
    expect(call.workspacePath).toBe(WORKSPACE_DIR)
    expect(call.args).toContain("run")
    expect(call.args).toContain("hello")
    expect(call.args).toContain("--auto")
  })

  test("propagates a fail-closed sandbox rejection as a non-recoverable CRASH error without spawning", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    const planSandboxedSpawn = vi
      .spyOn(sandboxModule, "planSandboxedSpawn")
      .mockRejectedValue(new Error('sessions/sandbox: no OS sandbox available for agent "opencode"'))

    const { OpencodeSession } = await import("./opencode-session")
    const session = new OpencodeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "opencode", timeout: 30, workspacePath: WORKSPACE_DIR })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.recoverable).toBe(false)
  })
})
