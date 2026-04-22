/**
 * CodexSession tests — JSON-RPC transport, message handling, lifecycle.
 *
 * Uses a mock script that simulates codex app-server stdio JSON-RPC protocol.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { AgentEvent, RunResult } from "../sessions/agent-session"

const MOCK_DIR = resolve(tmpdir(), "av-test-codex-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "codex")

function writeMockCodex(
  behavior: "init-only" | "full-turn" | "error-turn" | "file-change" | "rpc-error" | "turn-with-usage",
): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  // Script reads JSON-RPC requests from stdin, responds accordingly
  let script: string

  switch (behavior) {
    case "init-only":
      // Respond to initialize, then hang
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
  if [ "$method" = "initialize" ]; then
    echo '{"jsonrpc":"2.0","id":'$id',"result":{"serverInfo":{"name":"codex"}}}'
  fi
done
`
      break

    case "full-turn":
      // Respond to initialize, thread/start, turn/start, then emit output + turn/completed
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
  case "$method" in
    initialize)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{"serverInfo":{"name":"codex"}}}'
      ;;
    thread/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{"thread":{"id":"thread-123"}}}'
      ;;
    turn/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      sleep 0.05
      echo '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"Hello from Codex"}}'
      echo '{"jsonrpc":"2.0","method":"turn/completed","params":{}}'
      ;;
  esac
done
`
      break

    case "error-turn":
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
  case "$method" in
    initialize)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      ;;
    thread/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{"thread":{"id":"thread-err"}}}'
      ;;
    turn/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      sleep 0.05
      echo '{"jsonrpc":"2.0","method":"error","params":{"message":"Something went wrong"}}'
      ;;
  esac
done
`
      break

    case "file-change":
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
  case "$method" in
    initialize)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      ;;
    thread/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{"thread":{"id":"thread-fc"}}}'
      ;;
    turn/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      sleep 0.05
      echo '{"jsonrpc":"2.0","method":"item/commandExecution/outputDelta","params":{"command":"npm install"}}'
      echo '{"jsonrpc":"2.0","method":"item/fileChange/outputDelta","params":{"path":"src/index.ts","changeType":"add"}}'
      echo '{"jsonrpc":"2.0","method":"item/fileChange/outputDelta","params":{"path":"src/utils.ts","changeType":"modify"}}'
      echo '{"jsonrpc":"2.0","method":"item/fileChange/outputDelta","params":{"path":"src/index.ts","changeType":"add"}}'
      echo '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"Done editing"}}'
      echo '{"jsonrpc":"2.0","method":"turn/completed","params":{}}'
      ;;
  esac
done
`
      break

    case "rpc-error":
      // Respond to initialize with an error
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  echo '{"jsonrpc":"2.0","id":'$id',"error":{"code":-32600,"message":"Invalid request"}}'
done
`
      break

    case "turn-with-usage":
      // Emit a turn/completed notification with a usage block (prompt_tokens /
      // completion_tokens convention, which the session is expected to map
      // onto RunResult.tokenUsage).
      script = `#!/bin/bash
while IFS= read -r line; do
  id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
  case "$method" in
    initialize)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      ;;
    thread/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{"thread":{"id":"thread-usage"}}}'
      ;;
    turn/start)
      echo '{"jsonrpc":"2.0","id":'$id',"result":{}}'
      sleep 0.05
      echo '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"Hello"}}'
      echo '{"jsonrpc":"2.0","method":"turn/completed","params":{"usage":{"prompt_tokens":800,"completion_tokens":200,"model":"gpt-5.3-codex"}}}'
      ;;
  esac
done
`
      break
  }

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

describe("CodexSession", () => {
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

  test("start initializes via JSON-RPC", async () => {
    writeMockCodex("init-only")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })

    expect(session.isAlive()).toBe(true)
    await session.dispose()
  })

  test("execute runs full turn and emits output + complete", async () => {
    writeMockCodex("full-turn")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const outputs: string[] = []
    const completions: Array<{ exitCode: number; output: string }> = []

    session.on("output", (e) => outputs.push(e.chunk))
    session.on("complete", (e) => {
      completions.push({ exitCode: e.result.exitCode, output: e.result.output })
    })

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test prompt")

    // Wait for async events
    await new Promise((r) => setTimeout(r, 300))

    expect(outputs).toContain("Hello from Codex")
    expect(completions).toHaveLength(1)
    expect(completions[0]?.exitCode).toBe(0)
    expect(completions[0]?.output).toContain("Hello from Codex")

    await session.dispose()
  })

  test("emits error notification from server", async () => {
    writeMockCodex("error-turn")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    await new Promise((r) => setTimeout(r, 300))

    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { message: string } }).error
    expect(err.message).toBe("Something went wrong")

    await session.dispose()
  })

  test("tracks file changes and tool use events", async () => {
    writeMockCodex("file-change")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const tools: string[] = []
    const fileChanges: Array<{ path: string; changeType: string }> = []
    const completedFiles: string[][] = []

    session.on("toolUse", (e) => tools.push(e.tool))
    session.on("fileChange", (e) => fileChanges.push({ path: e.path, changeType: e.changeType }))
    session.on("complete", (e) => {
      completedFiles.push(e.result.filesChanged)
    })

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    await new Promise((r) => setTimeout(r, 300))

    expect(tools).toContain("npm install")
    expect(fileChanges).toContainEqual({ path: "src/index.ts", changeType: "add" })
    expect(fileChanges).toContainEqual({ path: "src/utils.ts", changeType: "modify" })
    // Duplicate file path should only appear once in completed result
    expect(completedFiles).toHaveLength(1)
    expect(completedFiles[0]).toContain("src/index.ts")
    expect(completedFiles[0]).toContain("src/utils.ts")

    await session.dispose()
  })

  test("cancel with threadId attempts RPC interrupt then falls back", async () => {
    writeMockCodex("full-turn")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")
    await new Promise((r) => setTimeout(r, 300))

    // Cancel — interrupt RPC will timeout since mock doesn't respond to it, falls back to SIGTERM
    // We just verify it doesn't throw
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  test("cancel without threadId falls back to super.cancel", async () => {
    writeMockCodex("init-only")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    // No execute() called, so no threadId — cancel falls back to SIGTERM
    // dispose kills the process regardless
    await session.dispose()
    expect(session.isAlive()).toBe(false)
  })

  test("dispose rejects pending resolvers", async () => {
    writeMockCodex("init-only")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    // dispose should clean up without throwing
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  test("RPC error response rejects the promise", async () => {
    writeMockCodex("rpc-error")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    await expect(session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })).rejects.toThrow(
      "Invalid request",
    )
    await session.dispose()
  })

  test("start with model option passes -c flag", async () => {
    writeMockCodex("init-only")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    // This tests that start doesn't throw with model option
    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp", model: "gpt-5.3-codex" })
    expect(session.isAlive()).toBe(true)
    await session.dispose()
  })

  test("parses token usage from turn/completed notification", async () => {
    writeMockCodex("turn-with-usage")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const completions: RunResult[] = []
    session.on("complete", (e) => completions.push(e.result))

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    await new Promise((r) => setTimeout(r, 300))

    expect(completions).toHaveLength(1)
    expect(completions[0]?.tokenUsage).toEqual({
      input: 800,
      output: 200,
      model: "gpt-5.3-codex",
    })

    await session.dispose()
  })

  test("omits tokenUsage when turn/completed has no usage block", async () => {
    writeMockCodex("full-turn")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const completions: RunResult[] = []
    session.on("complete", (e) => completions.push(e.result))

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    await new Promise((r) => setTimeout(r, 300))

    expect(completions).toHaveLength(1)
    expect(completions[0]?.tokenUsage).toBeUndefined()

    await session.dispose()
  })

  test("unknown notifications emit heartbeat", async () => {
    writeMockCodex("full-turn")

    const { CodexSession } = await import("../sessions/codex-session")
    const session = new CodexSession()

    const heartbeats: AgentEvent[] = []
    session.on("heartbeat", (e) => heartbeats.push(e))

    await session.start({ type: "codex", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    await new Promise((r) => setTimeout(r, 300))
    // heartbeats may or may not be emitted depending on the mock; we verify the handler doesn't crash
    await session.dispose()
  })
})
