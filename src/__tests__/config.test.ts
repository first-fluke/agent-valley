/**
 * Config Layer tests — loadConfig() validation and error messages.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { loadConfig } from "../config/config.ts"

/** Minimal valid env vars for loadConfig() to succeed. */
function validEnv(): Record<string, string> {
  return {
    LINEAR_API_KEY: "lin_api_test123",
    LINEAR_TEAM_ID: "ACR",
    LINEAR_TEAM_UUID: "uuid-team-123",
    LINEAR_WEBHOOK_SECRET: "whsec_test123",
    LINEAR_WORKFLOW_STATE_TODO: "state-todo-uuid",
    LINEAR_WORKFLOW_STATE_IN_PROGRESS: "state-ip-uuid",
    LINEAR_WORKFLOW_STATE_DONE: "state-done-uuid",
    LINEAR_WORKFLOW_STATE_CANCELLED: "state-cancelled-uuid",
    WORKSPACE_ROOT: "/tmp/workspaces",
    AGENT_TYPE: "claude",
    LOG_LEVEL: "info",
    LOG_FORMAT: "json",
    SERVER_PORT: "9741",
  }
}

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv
  let exitSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Prevent actual process.exit — throw instead so we can catch it
    exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`)
    })
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test("valid env vars produce correct Config object", () => {
    const env = validEnv()
    // Set all env vars
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v
    }

    const config = loadConfig()

    expect(config.linearApiKey).toBe("lin_api_test123")
    expect(config.linearTeamId).toBe("ACR")
    expect(config.linearTeamUuid).toBe("uuid-team-123")
    expect(config.linearWebhookSecret).toBe("whsec_test123")
    expect(config.workflowStates.todo).toBe("state-todo-uuid")
    expect(config.workflowStates.inProgress).toBe("state-ip-uuid")
    expect(config.workflowStates.done).toBe("state-done-uuid")
    expect(config.workflowStates.cancelled).toBe("state-cancelled-uuid")
    expect(config.workspaceRoot).toBe("/tmp/workspaces")
    expect(config.agentType).toBe("claude")
    expect(config.logLevel).toBe("info")
    expect(config.serverPort).toBe(9741)
  })

  test("missing LINEAR_API_KEY produces actionable error", () => {
    const env = validEnv()
    delete env.LINEAR_API_KEY
    process.env = { ...env }

    expect(() => loadConfig()).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]!
    expect(errorOutput).toContain("LINEAR_API_KEY")
    expect(errorOutput).toContain(".env")
  })

  test("missing LINEAR_TEAM_ID produces actionable error", () => {
    const env = validEnv()
    delete env.LINEAR_TEAM_ID
    process.env = { ...env }

    expect(() => loadConfig()).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]!
    expect(errorOutput).toContain("LINEAR_TEAM_ID")
  })

  test("missing multiple env vars lists all issues", () => {
    const env = validEnv()
    delete env.LINEAR_API_KEY
    delete env.LINEAR_WEBHOOK_SECRET
    delete env.WORKSPACE_ROOT
    process.env = { ...env }

    expect(() => loadConfig()).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]!
    expect(errorOutput).toContain("LINEAR_API_KEY")
    expect(errorOutput).toContain("LINEAR_WEBHOOK_SECRET")
    expect(errorOutput).toContain("WORKSPACE_ROOT")
  })

  test("non-absolute WORKSPACE_ROOT fails with fix message", () => {
    const env = validEnv()
    env.WORKSPACE_ROOT = "relative/path"
    process.env = { ...env }

    expect(() => loadConfig()).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]!
    expect(errorOutput).toContain("WORKSPACE_ROOT")
    expect(errorOutput).toContain("absolute path")
  })

  test("invalid LOG_LEVEL fails", () => {
    const env = validEnv()
    env.LOG_LEVEL = "verbose"
    process.env = { ...env }

    expect(() => loadConfig()).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]!
    expect(errorOutput).toContain("logLevel")
  })
})
