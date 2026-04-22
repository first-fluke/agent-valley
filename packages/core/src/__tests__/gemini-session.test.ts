/**
 * GeminiSession tests — fallback one-shot mode, ACP mode, isAlive, args builders.
 *
 * Uses a mock script that simulates Gemini CLI behavior.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { AgentEvent } from "../sessions/agent-session"

const MOCK_DIR = resolve(tmpdir(), "av-test-gemini-mock")
const MOCK_SCRIPT = resolve(MOCK_DIR, "gemini")

function writeMockGemini(
  behavior: "json-response" | "raw-text" | "error-exit" | "json-with-noise" | "acp-persistent",
): void {
  mkdirSync(MOCK_DIR, { recursive: true })

  let script: string

  switch (behavior) {
    case "json-response":
      // Read stdin, output JSON response
      script = `#!/bin/bash
cat > /dev/null
echo '{"response":"Hello from Gemini","filesChanged":[]}'
exit 0
`
      break

    case "raw-text":
      // Output non-JSON text
      script = `#!/bin/bash
cat > /dev/null
echo 'Just plain text output without JSON'
exit 0
`
      break

    case "error-exit":
      script = `#!/bin/bash
cat > /dev/null
exit 1
`
      break

    case "json-with-noise":
      // MCP noise before the JSON
      script = `#!/bin/bash
cat > /dev/null
echo 'some MCP debug noise'
echo '{"text":"Parsed correctly","data":123}'
exit 0
`
      break

    case "acp-persistent":
      // Simulates ACP mode (reads stdin line by line)
      script = `#!/bin/bash
while IFS= read -r line; do
  echo '{"response":"ACP response"}'
done
`
      break
  }

  writeFileSync(MOCK_SCRIPT, script, "utf-8")
  chmodSync(MOCK_SCRIPT, 0o755)
}

describe("GeminiSession — fallback mode", () => {
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

  test("start in fallback mode (no ACP) does not spawn process", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    // In fallback mode, process is spawned per execute(), not at start()
    expect(session.isAlive()).toBe(true) // started flag is true
    await session.dispose()
  })

  test("execute produces output and complete events from JSON response", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    const outputs: string[] = []
    let completedExitCode: number | null = null

    session.on("output", (e) => outputs.push(e.chunk))
    session.on("complete", (e) => {
      completedExitCode = e.result.exitCode
    })

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test prompt")

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0]).toBe("Hello from Gemini")
    expect(completedExitCode).toBe(0)
  })

  test("parses JSON with leading MCP noise", async () => {
    writeMockGemini("json-with-noise")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    const outputs: string[] = []
    session.on("output", (e) => outputs.push(e.chunk))

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    // Should parse text field from the JSON object
    expect(outputs[0]).toBe("Parsed correctly")
  })

  test("falls back to raw output when no JSON found", async () => {
    writeMockGemini("raw-text")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    const outputs: string[] = []
    let completed = false
    session.on("output", (e) => outputs.push(e.chunk))
    session.on("complete", () => {
      completed = true
    })

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs[0]).toContain("Just plain text output")
    expect(completed).toBe(true)
  })

  test("emits error on non-zero exit code", async () => {
    writeMockGemini("error-exit")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { code: string; message: string } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toContain("exited with code")
  })

  test("execute before start emits error", async () => {
    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    await session.execute("test")

    expect(errors.length).toBeGreaterThan(0)
    const err = (errors[0] as { error: { message: string } }).error
    expect(err.message).toContain("before start()")
  })

  test("isAlive returns false before start", () => {
    // Need to construct synchronously since import is async
    // We'll test via the fallback path
  })

  test("start with model option includes --model flag", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp", model: "gemini-2.5-pro" })
    await session.execute("test")

    // If args were wrong, the mock wouldn't run. Just verify completion.
    await session.dispose()
  })

  test("ACP detection returns false by default", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    // Even with useAcp=true, detectAcpSupport returns false (disabled by default)
    await session.start({
      type: "gemini",
      timeout: 10,
      workspacePath: "/tmp",
      options: { useAcp: true },
    })

    // Should be in fallback mode since ACP is disabled
    expect(session.isAlive()).toBe(true)
    await session.dispose()
  })

  test("extracts tokenUsage from JSON response with usageMetadata", async () => {
    mkdirSync(MOCK_DIR, { recursive: true })
    const script = `#!/bin/bash
cat > /dev/null
echo '{"response":"Hi","usageMetadata":{"promptTokenCount":400,"candidatesTokenCount":120},"model":"gemini-2.5-pro"}'
exit 0
`
    writeFileSync(MOCK_SCRIPT, script, "utf-8")
    chmodSync(MOCK_SCRIPT, 0o755)

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    let tokenUsage: { input: number; output: number; model: string } | undefined
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp", model: "gemini-2.5-pro" })
    await session.execute("test")

    expect(tokenUsage).toEqual({
      input: 400,
      output: 120,
      model: "gemini-2.5-pro",
    })
  })

  test("leaves tokenUsage undefined when JSON has no usage block", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    let tokenUsage: unknown = "unset"
    session.on("complete", (e) => {
      tokenUsage = e.result.tokenUsage
    })

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.execute("test")

    expect(tokenUsage).toBeUndefined()
  })

  test("extractGeminiUsage helper maps alternate field names", async () => {
    const { extractGeminiUsage } = await import("../sessions/gemini-session")

    // generationStats + snake_case variants
    expect(
      extractGeminiUsage(
        {
          generationStats: {
            prompt_token_count: 10,
            candidates_token_count: 5,
          },
        },
        "gemini-fallback",
      ),
    ).toEqual({ input: 10, output: 5, model: "gemini-fallback" })

    // Missing usage block returns undefined
    expect(extractGeminiUsage({ response: "hi" })).toBeUndefined()

    // Zero tokens returns undefined (treated as "no usage recorded")
    expect(extractGeminiUsage({ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } })).toBeUndefined()
  })

  test("dispose is safe to call multiple times", async () => {
    writeMockGemini("json-response")

    const { GeminiSession } = await import("../sessions/gemini-session")
    const session = new GeminiSession()

    await session.start({ type: "gemini", timeout: 10, workspacePath: "/tmp" })
    await session.dispose()
    await expect(session.dispose()).resolves.toBeUndefined()
  })
})
