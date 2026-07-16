/**
 * Verification Gate tests — runVerificationGate, resolveVerifyCommand,
 * buildVerificationFailurePrompt, and the real (non-injected) exec path.
 */
import { describe, expect, test } from "vitest"
import type { ResolvedRoute } from "../config/routing"
import type { Config } from "../config/yaml-loader"
import type { Workspace } from "../domain/models"
import {
  buildVerificationFailurePrompt,
  defaultVerifyExec,
  resolveVerifyCommand,
  runVerificationGate,
  type VerifyExecFn,
} from "../orchestrator/verification-gate"

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    issueId: "issue-1",
    path: "/workspace/PROJ-1",
    key: "PROJ-1",
    branch: "feature/PROJ-1",
    status: "running",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    workspaceRoot: "/workspace",
    agentType: "claude",
    deliveryMode: "merge",
    matchedLabel: null,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    trackerKind: "linear",
    linearApiKey: "key",
    linearTeamId: "PROJ",
    linearTeamUuid: "uuid",
    linearWebhookSecret: "secret",
    workflowStates: { todo: "s1", inProgress: "s2", done: "s3", cancelled: "s4" },
    workspaceRoot: "/workspace",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 2,
    serverPort: 9741,
    logLevel: "info",
    logFormat: "json",
    deliveryMode: "merge",
    routingRules: [],
    promptTemplate: "test",
    verify: { command: undefined, timeoutSec: 600 },
    ...overrides,
  } as Config
}

describe("resolveVerifyCommand", () => {
  test("returns undefined when neither project-wide nor route command is set", () => {
    const config = makeConfig()
    expect(resolveVerifyCommand(config, makeRoute())).toBeUndefined()
  })

  test("falls back to project-wide verify.command when route has no match", () => {
    const config = makeConfig({ verify: { command: "bun test", timeoutSec: 600 } })
    expect(resolveVerifyCommand(config, makeRoute())).toBe("bun test")
  })

  test("per-route verify_command overrides the project-wide command", () => {
    const config = makeConfig({
      verify: { command: "bun test", timeoutSec: 600 },
      routingRules: [
        {
          label: "scope:backend",
          workspaceRoot: "/repo",
          verifyCommand: "pytest && mypy .",
        },
      ],
    })
    const route = makeRoute({ matchedLabel: "scope:backend" })
    expect(resolveVerifyCommand(config, route)).toBe("pytest && mypy .")
  })

  test("falls back to project-wide command when the matched route has no verify_command", () => {
    const config = makeConfig({
      verify: { command: "bun test", timeoutSec: 600 },
      routingRules: [{ label: "scope:frontend", workspaceRoot: "/repo" }],
    })
    const route = makeRoute({ matchedLabel: "scope:frontend" })
    expect(resolveVerifyCommand(config, route)).toBe("bun test")
  })
})

describe("runVerificationGate", () => {
  test("is a documented no-op when command is undefined", async () => {
    const result = await runVerificationGate(makeWorkspace(), undefined)
    expect(result).toEqual({ ran: false, ok: true })
  })

  test("ok:true when the injected exec exits 0", async () => {
    const exec: VerifyExecFn = async () => ({ exitCode: 0, output: "all good", timedOut: false })
    const result = await runVerificationGate(makeWorkspace(), "bun test", { exec })
    expect(result).toEqual({ ran: true, ok: true, command: "bun test", output: "all good", timedOut: false })
  })

  test("ok:false when the injected exec exits non-zero, captures output", async () => {
    const exec: VerifyExecFn = async () => ({ exitCode: 1, output: "FAIL: 2 tests failed", timedOut: false })
    const result = await runVerificationGate(makeWorkspace(), "bun test", { exec })
    expect(result.ran).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.output).toBe("FAIL: 2 tests failed")
  })

  test("ok:false when the injected exec times out, even if exitCode looks like 0", async () => {
    const exec: VerifyExecFn = async () => ({ exitCode: 0, output: "hung", timedOut: true })
    const result = await runVerificationGate(makeWorkspace(), "bun test", { exec, timeoutSec: 1 })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  test("bounds captured output to the last 10KB", async () => {
    const huge = "x".repeat(20_000)
    const exec: VerifyExecFn = async () => ({ exitCode: 1, output: huge, timedOut: false })
    const result = await runVerificationGate(makeWorkspace(), "bun test", { exec })
    expect(result.output?.length).toBe(10_240)
    expect(result.output).toBe(huge.slice(-10_240))
  })

  test("passes cwd = workspace.path and timeoutSec to the exec function", async () => {
    let capturedCwd = ""
    let capturedTimeoutMs = 0
    const exec: VerifyExecFn = async (_command, cwd, timeoutMs) => {
      capturedCwd = cwd
      capturedTimeoutMs = timeoutMs
      return { exitCode: 0, output: "", timedOut: false }
    }
    await runVerificationGate(makeWorkspace({ path: "/workspace/PROJ-9" }), "bun test", { exec, timeoutSec: 30 })
    expect(capturedCwd).toBe("/workspace/PROJ-9")
    expect(capturedTimeoutMs).toBe(30_000)
  })
})

describe("defaultVerifyExec (real subprocess)", () => {
  test("resolves ok on a passing shell command", async () => {
    const result = await defaultVerifyExec("exit 0", process.cwd(), 5_000)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  test("captures stdout+stderr and a non-zero exit code on a failing command", async () => {
    const result = await defaultVerifyExec("echo boom 1>&2; exit 1", process.cwd(), 5_000)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("boom")
  })

  test("kills a hanging command and reports timedOut:true", async () => {
    const result = await defaultVerifyExec("sleep 5", process.cwd(), 200)
    expect(result.timedOut).toBe(true)
  }, 10_000)
})

describe("buildVerificationFailurePrompt", () => {
  test("includes command, retry instructions, and output for a plain failure", () => {
    const prompt = buildVerificationFailurePrompt({
      ran: true,
      ok: false,
      command: "bun test",
      output: "1 test failed",
      timedOut: false,
    })
    expect(prompt).toContain("Verification command failed: bun test")
    expect(prompt).toContain("1 test failed")
    expect(prompt).toContain("Retry instruction:")
  })

  test("uses a timeout-specific header when timedOut is true", () => {
    const prompt = buildVerificationFailurePrompt({
      ran: true,
      ok: false,
      command: "bun test",
      output: "",
      timedOut: true,
    })
    expect(prompt).toContain("Verification command timed out: bun test")
    expect(prompt).toContain("(no output captured)")
  })
})
