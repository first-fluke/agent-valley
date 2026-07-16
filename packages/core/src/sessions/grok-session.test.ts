/**
 * GrokSession tests — streaming NDJSON parse, token usage extraction,
 * file-change/tool-use detection, sandbox wrapping, and error/timeout
 * classification.
 *
 * Uses a mock `grok` script on PATH (same technique as
 * claude-session.test.ts / agy-session.test.ts). No real `grok` binary is
 * required, but the NDJSON event shapes below (`thought`/`text`/`end`)
 * ARE the real schema — captured by running the actual `grok` binary
 * (Grok Build v0.2.101, grok-4.5) against `--output-format
 * streaming-json`. See the module doc comment in grok-session.ts for the
 * full annotated schema and the parts that remain unconfirmed (error
 * signal shape, tool-call event shape).
 */

import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentEvent } from "../sessions/agent-session"
import * as sandboxModule from "../sessions/sandbox"

const MOCK_DIR = resolve(tmpdir(), "av-test-grok-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "grok")

function writeMockGrokLines(ndjsonLines: string[]): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  const script = ["#!/bin/bash", ...ndjsonLines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`), "exit 0"].join(
    "\n",
  )

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

function writeMockGrokRaw(script: string): void {
  mkdirSync(MOCK_DIR, { recursive: true })
  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

/** Real `end` event shape (Grok Build v0.2.101, grok-4.5), usage/model omitted per-test as needed. */
function endEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "sess-1",
    requestId: "req-1",
    num_turns: 1,
    ...overrides,
  })
}

describe("GrokSession — streaming output", () => {
  let originalPath: string

  beforeEach(() => {
    originalPath = process.env.PATH ?? ""
    // Prepend mock dir to PATH so "grok" resolves to our mock
    process.env.PATH = `${MOCK_DIR}:${originalPath}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    try {
      unlinkSync(MOCK_SCRIPT)
    } catch {
      // ignore
    }
  })

  test("streams answer text chunks and concatenates them into the final result", async () => {
    writeMockGrokLines([
      JSON.stringify({ type: "text", data: "Hello " }),
      JSON.stringify({ type: "text", data: "World" }),
      endEvent(),
    ])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    const chunks: string[] = []
    let completed: AgentEvent | null = null

    session.on("output", (e) => chunks.push(e.chunk))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test prompt")

    // Each type:"text" chunk is streamed individually as an "output" event...
    expect(chunks).toEqual(["Hello ", "World"])
    // ...and the terminal "end" event's RunResult.output is their concatenation
    // (grok's "end" event does not itself carry the final text, unlike
    // Claude's "result" event).
    expect(completed).not.toBeNull()
    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("Hello World")
  })

  test("drops 'thought' (reasoning) chunks from the final answer and surfaces them as heartbeats", async () => {
    writeMockGrokLines([
      JSON.stringify({ type: "thought", data: "Let me think about this..." }),
      JSON.stringify({ type: "text", data: "The answer is 42" }),
      endEvent(),
    ])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    const chunks: string[] = []
    const heartbeats: AgentEvent[] = []
    let completed: AgentEvent | null = null

    session.on("output", (e) => chunks.push(e.chunk))
    session.on("heartbeat", (e) => heartbeats.push(e))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test prompt")

    // Reasoning text never appears in "output" events or the final result
    expect(chunks).toEqual(["The answer is 42"])
    expect(chunks.join("")).not.toContain("Let me think")
    expect(heartbeats.length).toBeGreaterThan(0)

    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("The answer is 42")
    expect(result.output).not.toContain("Let me think")
  })

  test("does not OOM with large streamed output (bounded tail, not full accumulation)", async () => {
    const bigChunk = "x".repeat(1024)
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({ type: "text", data: bigChunk }))
    }
    lines.push(endEvent())

    writeMockGrokLines(lines)

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let chunkCount = 0
    let completed = false
    let finalOutputLength = 0

    session.on("output", () => chunkCount++)
    session.on("complete", (e) => {
      completed = true
      finalOutputLength = e.result.output.length
    })

    await session.start({ type: "grok", timeout: 60, workspacePath: "/tmp" })

    const memBefore = process.memoryUsage().heapUsed
    await session.execute("test prompt")
    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)
    // Bounded tail, not the full ~1MB stream
    expect(finalOutputLength).toBeLessThanOrEqual(10 * 1024)

    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50)
  })

  test("emits tool use and file change events (hint-matched tool names — event shape unconfirmed)", async () => {
    writeMockGrokLines([
      JSON.stringify({ type: "tool_use", name: "write_file", input: { file_path: "/tmp/foo.ts" } }),
      JSON.stringify({ type: "tool_use", name: "edit_file", input: { file_path: "/tmp/bar.ts" } }),
      JSON.stringify({ type: "text", data: "done" }),
      endEvent(),
    ])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tools).toEqual(["write_file", "edit_file"])
    expect(files).toEqual([
      { path: "/tmp/foo.ts", changeType: "add" },
      { path: "/tmp/bar.ts", changeType: "modify" },
    ])
  })

  test("emits error on an 'end' event carrying an explicit error field (signal unconfirmed against real output)", async () => {
    writeMockGrokLines([endEvent({ error: "something went wrong" })])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(error).not.toBeNull()
    expect((error as unknown as { error: { message: string } }).error.message).toBe("something went wrong")
  })

  test("extracts tokenUsage from the 'end' event's usage + modelUsage (real schema)", async () => {
    writeMockGrokLines([
      JSON.stringify({ type: "text", data: "PONG" }),
      endEvent({
        usage: {
          input_tokens: 2836,
          cache_read_input_tokens: 23808,
          output_tokens: 79,
          reasoning_tokens: 70,
          total_tokens: 26723,
        },
        num_turns: 2,
        modelUsage: {
          "grok-4.5": { inputTokens: 2836, outputTokens: 79, cacheReadInputTokens: 23808, modelCalls: 2 },
        },
      }),
    ])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    // input/output map 1:1 from usage.input_tokens/output_tokens; model is
    // the single modelUsage key. cache_read_input_tokens and
    // reasoning_tokens are deliberately ignored (not folded into input) —
    // see grok-session.ts module doc comment for the rationale.
    expect(tokenUsage).toEqual({ input: 2836, output: 79, model: "grok-4.5" })
  })

  test("falls back to config.model then 'grok' when modelUsage is absent", async () => {
    writeMockGrokLines([endEvent({ usage: { input_tokens: 10, output_tokens: 5 } })])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp", model: "grok-4-fast" })
    await session.execute("test")

    expect(tokenUsage).toEqual({ input: 10, output: 5, model: "grok-4-fast" })
  })

  test("'end' event without usage leaves tokenUsage undefined", async () => {
    writeMockGrokLines([endEvent()])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let tokenUsage: unknown = "unset"
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tokenUsage).toBeUndefined()
  })

  test("result output (concatenated text chunks) is capped at 10KB", async () => {
    const bigChunk = "y".repeat(20_000)
    writeMockGrokLines([JSON.stringify({ type: "text", data: bigChunk }), endEvent()])

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let output = ""
    session.on("complete", (e) => {
      output = (e as unknown as { result: { output: string } }).result.output
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(output.length).toBe(10240)
    // Bounded tail keeps the *last* 10KB
    expect(output).toBe(bigChunk.slice(-10240))
  })

  test("invokes grok with --single, --output-format streaming-json, --always-approve; prompt passed as --single argument (not stdin)", async () => {
    // Argv is echoed back inside a "text" event's data field so the test
    // can read it via the "complete" event — matches the technique used by
    // agy-session.test.ts's "capture-args" mock (a marker-file write from
    // inside the sandboxed child is unreliable across platforms).
    writeMockGrokRaw(`#!/bin/bash
printf '{"type":"text","data":"ARGS:%s"}\\n' "$*"
printf '{"type":"end","stopReason":"EndTurn"}\\n'
exit 0
`)

    const { GrokSession, GROK_COMMAND } = await import("../sessions/grok-session")
    expect(GROK_COMMAND).toBe("grok")

    const session = new GrokSession()
    let captured = ""
    session.on("complete", (e) => {
      captured = e.result.output
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("distinctive-test-prompt")

    expect(captured).toContain("--single")
    expect(captured).toContain("distinctive-test-prompt")
    expect(captured).toContain("--output-format")
    expect(captured).toContain("streaming-json")
    expect(captured).toContain("--always-approve")
  })

  test("execute before start emits CRASH error", async () => {
    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.execute("test")

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("before start()")
  })

  test("classifies a non-zero exit code as CRASH", async () => {
    writeMockGrokRaw(`#!/bin/bash
exit 1
`)

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
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
    writeMockGrokRaw(`#!/bin/bash
exec sleep 5
`)

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    const execPromise = session.execute("test")

    // Give the sandboxed child a moment to actually spawn before killing it.
    await new Promise((r) => setTimeout(r, 300))
    await session.kill()
    await execPromise

    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string } }).error
    expect(err.code).toBe("TIMEOUT")
  })
})

describe("GrokSession — sandbox wrapping", () => {
  // vi.spyOn on a namespace import, not vi.doMock()+vi.resetModules()+a
  // fresh dynamic import per test: the doMock/resetModules combination
  // was flaky here (~1-in-5 to 1-in-10 runs hung for 5s) because it
  // tears down and rebuilds the whole module graph mid-file, racing
  // against the "streaming output" describe block's real (unmocked)
  // spawns that share the same module registry within this test file.
  // spyOn only patches the one export in place and is restored per-test,
  // so it never touches module identity or the other describe block.
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      unlinkSync(MOCK_SCRIPT)
    } catch {
      // ignore
    }
  })

  test("routes every spawn through planSandboxedSpawn with agentType 'grok' and the built argv", async () => {
    // Resolve the mocked plan to an absolute no-op script rather than a
    // bare command name — avoids depending on the test runner's PATH
    // containing a specific binary.
    writeMockGrokRaw("#!/bin/bash\nexit 0\n")
    const planSandboxedSpawn = vi.spyOn(sandboxModule, "planSandboxedSpawn").mockResolvedValue({
      command: MOCK_SCRIPT,
      args: [],
      sandboxed: true,
      platform: "darwin" as NodeJS.Platform,
      networkAllowlist: [],
    })

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    // workspacePath must exist — it's also used as the spawned process's
    // cwd, and a missing cwd surfaces as a misleading ENOENT on the
    // executable rather than on the directory.
    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    const call = planSandboxedSpawn.mock.calls[0]?.[0] as {
      agentType: string
      command: string
      args: string[]
      workspacePath: string
    }
    expect(call.agentType).toBe("grok")
    expect(call.command).toBe("grok")
    expect(call.workspacePath).toBe("/tmp")
    expect(call.args).toContain("--single")
    expect(call.args).toContain("hello")
    expect(call.args).toContain("--always-approve")
  })

  test("propagates a fail-closed sandbox rejection as a CRASH error without spawning", async () => {
    const planSandboxedSpawn = vi
      .spyOn(sandboxModule, "planSandboxedSpawn")
      .mockRejectedValue(
        new Error('sessions/sandbox: no OS sandbox available for agent "grok" on platform "linux" (missing: bwrap).'),
      )

    const { GrokSession } = await import("../sessions/grok-session")
    const session = new GrokSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "grok", timeout: 30, workspacePath: "/tmp" })
    await session.execute("hello")

    expect(planSandboxedSpawn).toHaveBeenCalledTimes(1)
    expect(error).not.toBeNull()
    const err = (error as unknown as { error: { code: string; message: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("no OS sandbox available")
    expect(err.recoverable).toBe(false)
  })
})
