/**
 * BaseSession tests — event emitter, process management, buildAgentEnv, waitForExit.
 */
import { spawn } from "node:child_process"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { AgentConfig, AgentEvent } from "../sessions/agent-session"
import { BaseSession, buildAgentEnv, waitForExit } from "../sessions/base-session"

// Concrete subclass for testing abstract BaseSession
class TestSession extends BaseSession {
  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.startedAt = Date.now()
    // Spawn a shell that traps signals and exits — reliable cross-platform
    this.process = spawn("bash", ["-c", "trap 'exit 0' TERM INT; while true; do sleep 0.1; done"])
  }

  async execute(_prompt: string): Promise<void> {
    // no-op for testing
  }

  // Expose protected methods for testing
  public testEmit(event: AgentEvent): void {
    this.emit(event)
  }

  public testEmitError(code: "CRASH" | "TIMEOUT", message: string, recoverable: boolean): void {
    this.emitError(code, message, recoverable)
  }

  public testBuildRunResult(output: string, filesChanged?: string[]) {
    return this.buildRunResult(output, filesChanged)
  }

  public testElapsedMs(): number {
    return this.elapsedMs()
  }

  public testAssertStarted(): boolean {
    return this.assertStarted()
  }
}

// ── buildAgentEnv ───────────────────────────────────────────────────

describe("buildAgentEnv", () => {
  test("includes safe system env keys", () => {
    const env = buildAgentEnv("claude")
    // PATH should always be present
    expect(env.PATH).toBeDefined()
    expect(env.HOME).toBeDefined()
  })

  test("includes agent-specific keys for claude", () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "test-key"
    try {
      const env = buildAgentEnv("claude")
      expect(env.ANTHROPIC_API_KEY).toBe("test-key")
    } finally {
      if (original != null) process.env.ANTHROPIC_API_KEY = original
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  test("includes agent-specific keys for codex", () => {
    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "openai-test"
    try {
      const env = buildAgentEnv("codex")
      expect(env.OPENAI_API_KEY).toBe("openai-test")
    } finally {
      if (original != null) process.env.OPENAI_API_KEY = original
      else delete process.env.OPENAI_API_KEY
    }
  })

  test("includes agent-specific keys for antigravity", () => {
    const origGoogle = process.env.GOOGLE_API_KEY
    const origGemini = process.env.GEMINI_API_KEY
    process.env.GOOGLE_API_KEY = "google-test"
    process.env.GEMINI_API_KEY = "gemini-test"
    try {
      const env = buildAgentEnv("antigravity")
      expect(env.GOOGLE_API_KEY).toBe("google-test")
      expect(env.GEMINI_API_KEY).toBe("gemini-test")
    } finally {
      if (origGoogle != null) process.env.GOOGLE_API_KEY = origGoogle
      else delete process.env.GOOGLE_API_KEY
      if (origGemini != null) process.env.GEMINI_API_KEY = origGemini
      else delete process.env.GEMINI_API_KEY
    }
  })

  test("includes agent-specific keys for cursor", () => {
    const original = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = "cursor-test"
    try {
      const env = buildAgentEnv("cursor")
      expect(env.CURSOR_API_KEY).toBe("cursor-test")
    } finally {
      if (original != null) process.env.CURSOR_API_KEY = original
      else delete process.env.CURSOR_API_KEY
    }
  })

  test("includes agent-specific keys for grok", () => {
    const origXai = process.env.XAI_API_KEY
    const origGrok = process.env.GROK_API_KEY
    process.env.XAI_API_KEY = "xai-test"
    process.env.GROK_API_KEY = "grok-test"
    try {
      const env = buildAgentEnv("grok")
      expect(env.XAI_API_KEY).toBe("xai-test")
      expect(env.GROK_API_KEY).toBe("grok-test")
    } finally {
      if (origXai != null) process.env.XAI_API_KEY = origXai
      else delete process.env.XAI_API_KEY
      if (origGrok != null) process.env.GROK_API_KEY = origGrok
      else delete process.env.GROK_API_KEY
    }
  })

  test("merges extra env vars", () => {
    const env = buildAgentEnv("claude", { MY_VAR: "hello" })
    expect(env.MY_VAR).toBe("hello")
  })

  test("extra env vars override defaults", () => {
    const env = buildAgentEnv("claude", { PATH: "/custom/path" })
    expect(env.PATH).toBe("/custom/path")
  })

  test("unknown agent type gets no agent-specific keys", () => {
    const env = buildAgentEnv("unknown-agent")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

// ── waitForExit ─────────────────────────────────────────────────────

describe("waitForExit", () => {
  test("resolves immediately if process already exited", async () => {
    const proc = spawn("true")
    await new Promise((r) => proc.once("close", r))
    // Process already exited
    await expect(waitForExit(proc)).resolves.toBeUndefined()
  })

  test("resolves when process closes", async () => {
    const proc = spawn("sleep", ["0.01"])
    await expect(waitForExit(proc)).resolves.toBeUndefined()
  })
})

// ── BaseSession event emitter ───────────────────────────────────────

describe("BaseSession — event emitter", () => {
  let session: TestSession

  beforeEach(() => {
    session = new TestSession()
  })

  test("on/emit delivers events to handlers", () => {
    const chunks: string[] = []
    session.on("output", (e) => chunks.push(e.chunk))

    session.testEmit({ type: "output", chunk: "hello" })
    session.testEmit({ type: "output", chunk: "world" })

    expect(chunks).toEqual(["hello", "world"])
  })

  test("multiple handlers receive the same event", () => {
    const results: string[] = []
    session.on("output", () => results.push("handler1"))
    session.on("output", () => results.push("handler2"))

    session.testEmit({ type: "output", chunk: "test" })

    expect(results).toEqual(["handler1", "handler2"])
  })

  test("off removes a handler", () => {
    const chunks: string[] = []
    const handler = (e: Extract<AgentEvent, { type: "output" }>) => chunks.push(e.chunk)

    session.on("output", handler)
    session.testEmit({ type: "output", chunk: "before" })
    session.off("output", handler)
    session.testEmit({ type: "output", chunk: "after" })

    expect(chunks).toEqual(["before"])
  })

  test("emit with no handlers does not throw", () => {
    expect(() => session.testEmit({ type: "heartbeat", timestamp: "now" })).not.toThrow()
  })
})

// ── BaseSession process management ──────────────────────────────────

describe("BaseSession — process management", () => {
  let session: TestSession

  beforeEach(() => {
    session = new TestSession()
  })

  afterEach(async () => {
    await session.dispose()
  })

  test("isAlive returns false before start", () => {
    expect(session.isAlive()).toBe(false)
  })

  test("isAlive returns true after start", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    expect(session.isAlive()).toBe(true)
  })

  test("cancel on running process does not throw", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    expect(session.isAlive()).toBe(true)
    await expect(session.cancel()).resolves.toBeUndefined()
    // Dispose to clean up
    await session.dispose()
  })

  test("kill on running process does not throw", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    await expect(session.kill()).resolves.toBeUndefined()
    await session.dispose()
  })

  test("dispose kills process and it becomes not alive", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    expect(session.isAlive()).toBe(true)
    await session.dispose()
    expect(session.isAlive()).toBe(false)
  })

  test("cancel on dead process is no-op", async () => {
    // No process started
    await expect(session.cancel()).resolves.toBeUndefined()
  })

  test("kill on dead process is no-op", async () => {
    await expect(session.kill()).resolves.toBeUndefined()
  })

  test("dispose kills process and clears listeners", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    session.on("output", () => {})

    await session.dispose()

    expect(session.isAlive()).toBe(false)
  })

  test("dispose on already-dead session is safe", async () => {
    await expect(session.dispose()).resolves.toBeUndefined()
  })
})

// ── BaseSession helpers ─────────────────────────────────────────────

describe("BaseSession — helpers", () => {
  let session: TestSession

  beforeEach(() => {
    session = new TestSession()
  })

  afterEach(async () => {
    await session.dispose()
  })

  test("assertStarted returns false and emits error when no process", () => {
    const errors: AgentEvent[] = []
    session.on("error", (e) => errors.push(e))

    expect(session.testAssertStarted()).toBe(false)
    expect(errors).toHaveLength(1)
  })

  test("assertStarted returns true when process is alive", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    expect(session.testAssertStarted()).toBe(true)
  })

  test("emitError emits structured error event", () => {
    let received: AgentEvent | null = null
    session.on("error", (e) => {
      received = e
    })

    session.testEmitError("CRASH", "test error", true)

    expect(received).not.toBeNull()
    const err = (received as unknown as { error: { code: string; message: string; recoverable: boolean } }).error
    expect(err.code).toBe("CRASH")
    expect(err.message).toBe("test error")
    expect(err.recoverable).toBe(true)
  })

  test("buildRunResult caps output at 10KB", () => {
    const bigOutput = "y".repeat(20_000)
    const result = session.testBuildRunResult(bigOutput)
    expect(result.output.length).toBe(10 * 1024)
  })

  test("buildRunResult preserves short output", () => {
    const result = session.testBuildRunResult("short output", ["file1.ts"])
    expect(result.output).toBe("short output")
    expect(result.filesChanged).toEqual(["file1.ts"])
  })

  test("elapsedMs returns time since start", async () => {
    await session.start({ type: "test", timeout: 30, workspacePath: "/tmp" })
    await new Promise((r) => setTimeout(r, 50))
    expect(session.testElapsedMs()).toBeGreaterThan(0)
  })
})
