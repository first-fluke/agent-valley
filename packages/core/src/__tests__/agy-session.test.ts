/**
 * AgySession tests — non-interactive invocation, streaming, sandbox
 * wrapping, and graceful failure paths.
 *
 * Uses a mock `agy` script on PATH (same technique as
 * claude-session.test.ts / grok-session.test.ts). Runs through the real
 * `planSandboxedSpawn` (sandbox-exec on macOS / bwrap on Linux) — no
 * mocking of the sandbox layer, matching existing session test coverage.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { AgentEvent } from "../sessions/agent-session"

const MOCK_DIR = resolve(tmpdir(), "av-test-agy-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "agy")

type MockBehavior = "plain-text" | "multiline" | "error-exit" | "capture-args" | "large-output"

function writeMockAgy(behavior: MockBehavior): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  let script: string

  switch (behavior) {
    case "plain-text":
      script = `#!/bin/bash
echo 'Hello from Agy'
exit 0
`
      break

    case "multiline":
      script = `#!/bin/bash
echo 'line one'
echo 'line two'
exit 0
`
      break

    case "error-exit":
      script = `#!/bin/bash
exit 1
`
      break

    case "capture-args":
      // Argv is echoed as a plain line so the test can read it back via
      // the "output" event.
      script = `#!/bin/bash
echo "ARGS:$@"
exit 0
`
      break

    case "large-output": {
      const lines: string[] = []
      for (let i = 0; i < 1000; i++) {
        lines.push(`echo '${"x".repeat(1024)}'`)
      }
      script = `#!/bin/bash
${lines.join("\n")}
exit 0
`
      break
    }
  }

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

describe("AgySession", () => {
  let originalPath: string

  beforeEach(() => {
    originalPath = process.env.PATH ?? ""
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

  test("start sets started state without spawning a process", async () => {
    writeMockAgy("plain-text")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    expect(session.isAlive()).toBe(true) // started flag, no process spawned yet
    await session.dispose()
  })

  test("execute spawns agy non-interactively and emits output + complete", async () => {
    writeMockAgy("plain-text")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    const outputs: string[] = []
    let completedExitCode: number | null = null

    session.on("output", (e) => outputs.push(e.chunk))
    session.on("complete", (e) => {
      completedExitCode = e.result.exitCode
    })

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test prompt")

    expect(outputs).toEqual(["Hello from Agy"])
    expect(completedExitCode).toBe(0)
  })

  test("streams multiple lines as separate output events", async () => {
    writeMockAgy("multiline")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    const outputs: string[] = []
    session.on("output", (e) => outputs.push(e.chunk))

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(outputs).toEqual(["line one", "line two"])
  })

  test("emits CRASH error on non-zero exit code", async () => {
    writeMockAgy("error-exit")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { code: string; message: string } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("exited with code")
  })

  test("execute before start emits error", async () => {
    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    await session.execute("test")

    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { message: string } }).error
    expect(err.message).toContain("before start()")
  })

  test("tokenUsage is always undefined — agy print mode has no structured output", async () => {
    writeMockAgy("plain-text")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    let tokenUsage: unknown = "unset"
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tokenUsage).toBeUndefined()
  })

  test("rejects an oversized prompt before spawning, with an actionable error", async () => {
    writeMockAgy("plain-text")

    const { AgySession, AGY_MAX_PROMPT_ARG_BYTES } = await import("../sessions/agy-session")
    const session = new AgySession()

    const errors: AgentEvent[] = []
    const completes: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))
    session.on("complete", (e) => completes.push(e))

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.execute("x".repeat(AGY_MAX_PROMPT_ARG_BYTES + 1))

    expect(completes).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { code: string; message: string } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("exceeding")
    expect(err.message.toLowerCase()).toContain("fix:")
  })

  test("invokes agy non-interactively with -p <prompt>, skip-permissions, mode, print-timeout, and conversation flags", async () => {
    writeMockAgy("capture-args")

    const {
      AgySession,
      AGY_FLAG_PRINT,
      AGY_FLAG_SKIP_PERMISSIONS,
      AGY_FLAG_CONVERSATION,
      AGY_FLAG_MODE,
      AGY_MODE_ACCEPT_EDITS,
      AGY_FLAG_PRINT_TIMEOUT,
      AGY_FLAG_OWN_SANDBOX,
    } = await import("../sessions/agy-session")
    const session = new AgySession()

    const outputs: string[] = []
    session.on("output", (e) => outputs.push(e.chunk))

    await session.start({ type: "antigravity", timeout: 42, workspacePath: "/tmp" })
    await session.execute("test prompt")

    const captured = outputs.find((line) => line.startsWith("ARGS:")) ?? ""
    expect(captured).toContain(AGY_FLAG_PRINT)
    // Prompt IS passed as the -p argv value (agy's documented usage — not stdin)
    expect(captured).toContain("test prompt")
    expect(captured).toContain(AGY_FLAG_SKIP_PERMISSIONS)
    expect(captured).toContain(`${AGY_FLAG_MODE} ${AGY_MODE_ACCEPT_EDITS}`)
    expect(captured).toContain(`${AGY_FLAG_PRINT_TIMEOUT} 42s`)
    expect(captured).toContain(AGY_FLAG_CONVERSATION)
    // agy's own --sandbox layer is deliberately not used — OS sandbox only
    expect(captured).not.toContain(AGY_FLAG_OWN_SANDBOX)
  })

  test("honors config.options.mode override", async () => {
    writeMockAgy("capture-args")

    const { AgySession, AGY_FLAG_MODE, AGY_MODE_PLAN } = await import("../sessions/agy-session")
    const session = new AgySession()

    const outputs: string[] = []
    session.on("output", (e) => outputs.push(e.chunk))

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp", options: { mode: AGY_MODE_PLAN } })
    await session.execute("test")

    const captured = outputs.find((line) => line.startsWith("ARGS:")) ?? ""
    expect(captured).toContain(`${AGY_FLAG_MODE} ${AGY_MODE_PLAN}`)
  })

  test("reuses the same --conversation id across execute() calls for session continuity", async () => {
    writeMockAgy("capture-args")

    const { AgySession, AGY_FLAG_CONVERSATION } = await import("../sessions/agy-session")
    const session = new AgySession()

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })

    const firstOutputs: string[] = []
    session.on("output", (e) => firstOutputs.push(e.chunk))
    await session.execute("first")
    const firstArgs = firstOutputs.find((line) => line.startsWith("ARGS:")) ?? ""
    const firstId = firstArgs.split(AGY_FLAG_CONVERSATION)[1]?.trim().split(" ")[0]

    const secondOutputs: string[] = []
    session.on("output", (e) => secondOutputs.push(e.chunk))
    await session.execute("second")
    const secondArgs = secondOutputs.find((line) => line.startsWith("ARGS:")) ?? ""
    const secondId = secondArgs.split(AGY_FLAG_CONVERSATION)[1]?.trim().split(" ")[0]

    expect(firstId).toBeTruthy()
    expect(firstId).toBe(secondId)
  })

  test("streams large output without unbounded accumulation", async () => {
    writeMockAgy("large-output")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    let chunkCount = 0
    let completed = false
    let finalOutputLength = 0

    session.on("output", () => chunkCount++)
    session.on("complete", (e) => {
      completed = true
      finalOutputLength = e.result.output.length
    })

    await session.start({ type: "antigravity", timeout: 30, workspacePath: "/tmp" })

    const memBefore = process.memoryUsage().heapUsed
    await session.execute("test prompt")
    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)
    // Final result is capped, not the full ~1MB stream
    expect(finalOutputLength).toBeLessThanOrEqual(10 * 1024)

    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50)
  })

  test("dispose is safe to call multiple times", async () => {
    writeMockAgy("plain-text")

    const { AgySession } = await import("../sessions/agy-session")
    const session = new AgySession()

    await session.start({ type: "antigravity", timeout: 10, workspacePath: "/tmp" })
    await session.dispose()
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  test("formatAgyTimeout converts whole seconds to a Go-style duration string", async () => {
    const { formatAgyTimeout } = await import("../sessions/agy-session")

    expect(formatAgyTimeout(42)).toBe("42s")
    expect(formatAgyTimeout(0)).toBe("1s") // clamped to a minimum of 1s
    expect(formatAgyTimeout(300)).toBe("300s")
  })
})
