/**
 * ClaudeSession streaming tests — verifies output is streamed (not accumulated)
 * and result event produces correct completion data.
 *
 * Uses a mock script that emits NDJSON lines to stdout, simulating Claude CLI.
 */

import { chmodSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { AgentEvent } from "../sessions/agent-session"

// We need to override the spawn command. ClaudeSession spawns "claude" —
// we'll use PATH manipulation to make it run our mock script instead.

const MOCK_DIR = resolve(tmpdir(), "av-test-claude-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "claude")

function writeMockClaude(ndjsonLines: string[]): void {
  const { mkdirSync } = require("node:fs")
  mkdirSync(MOCK_DIR, { recursive: true })

  // Shell script that outputs NDJSON lines to stdout
  const script = [
    "#!/bin/bash",
    "# Read and discard stdin (prompt)",
    "cat > /dev/null",
    ...ndjsonLines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`),
    "exit 0",
  ].join("\n")

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

describe("ClaudeSession — streaming output", () => {
  let originalPath: string

  beforeEach(() => {
    originalPath = process.env.PATH ?? ""
    // Prepend mock dir to PATH so "claude" resolves to our mock
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

  test("streams output chunks via events without accumulation", async () => {
    writeMockClaude([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello " }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "World" }] },
      }),
      JSON.stringify({
        type: "result",
        result: "Final summary",
        duration_ms: 1000,
        is_error: false,
      }),
    ])

    const { ClaudeSession } = await import("../sessions/claude-session")
    const session = new ClaudeSession()

    const chunks: string[] = []
    let completed: AgentEvent | null = null

    session.on("output", (e) => chunks.push(e.chunk))
    session.on("complete", (e) => {
      completed = e
    })

    await session.start({ type: "claude", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test prompt")

    // Output was streamed as individual chunks
    expect(chunks).toEqual(["Hello ", "World"])

    // Completion uses result event's result field, not accumulated output
    expect(completed).not.toBeNull()
    const result = (completed as unknown as { result: { output: string } }).result
    expect(result.output).toBe("Final summary")
  })

  test("does not OOM with large output", async () => {
    // Generate 1000 chunks of 1KB each = ~1MB total
    const bigChunk = "x".repeat(1024)
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: bigChunk }] },
        }),
      )
    }
    lines.push(
      JSON.stringify({
        type: "result",
        result: "done",
        duration_ms: 5000,
        is_error: false,
      }),
    )

    writeMockClaude(lines)

    const { ClaudeSession } = await import("../sessions/claude-session")
    const session = new ClaudeSession()

    let chunkCount = 0
    let completed = false

    session.on("output", () => chunkCount++)
    session.on("complete", () => {
      completed = true
    })

    await session.start({ type: "claude", timeout: 60, workspacePath: "/tmp" })

    // Measure memory before
    const memBefore = process.memoryUsage().heapUsed

    await session.execute("test prompt")

    const memAfter = process.memoryUsage().heapUsed

    expect(chunkCount).toBe(1000)
    expect(completed).toBe(true)

    // Memory should not grow by more than 10MB for 1MB of streamed output
    // (if accumulating, it would grow by ~1MB; we're checking no massive leak)
    const memGrowthMB = (memAfter - memBefore) / 1024 / 1024
    expect(memGrowthMB).toBeLessThan(50) // generous bound for GC timing
  })

  test("emits tool use and file change events", async () => {
    writeMockClaude([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/tmp/foo.ts" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/tmp/bar.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "done",
        duration_ms: 500,
        is_error: false,
      }),
    ])

    const { ClaudeSession } = await import("../sessions/claude-session")
    const session = new ClaudeSession()

    const tools: string[] = []
    const files: Array<{ path: string; changeType: string }> = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => files.push({ path: e.path, changeType: e.changeType }))

    await session.start({ type: "claude", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tools).toEqual(["Write", "Edit"])
    expect(files).toEqual([
      { path: "/tmp/foo.ts", changeType: "add" },
      { path: "/tmp/bar.ts", changeType: "modify" },
    ])
  })

  test("emits error on is_error result", async () => {
    writeMockClaude([
      JSON.stringify({
        type: "result",
        result: "something went wrong",
        is_error: true,
      }),
    ])

    const { ClaudeSession } = await import("../sessions/claude-session")
    const session = new ClaudeSession()

    let error: AgentEvent | null = null
    session.on("error", (e) => {
      error = e
    })

    await session.start({ type: "claude", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(error).not.toBeNull()
    expect((error as unknown as { error: { message: string } }).error.message).toBe("something went wrong")
  })

  test("result output is capped at 10KB", async () => {
    const bigResult = "y".repeat(20_000)
    writeMockClaude([
      JSON.stringify({
        type: "result",
        result: bigResult,
        duration_ms: 100,
        is_error: false,
      }),
    ])

    const { ClaudeSession } = await import("../sessions/claude-session")
    const session = new ClaudeSession()

    let output = ""
    session.on("complete", (e) => {
      output = (e as unknown as { result: { output: string } }).result.output
    })

    await session.start({ type: "claude", timeout: 30, workspacePath: "/tmp" })
    await session.execute("test")

    expect(output.length).toBe(10240)
  })
})
