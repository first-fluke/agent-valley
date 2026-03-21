import { describe, test, expect } from "bun:test"
import { toOrchestratorConfig } from "../lib/env"

describe("toOrchestratorConfig", () => {
  test("maps env vars to orchestrator config shape", () => {
    const config = toOrchestratorConfig()

    // Verify shape has all required keys
    expect(config).toHaveProperty("linearApiKey")
    expect(config).toHaveProperty("linearTeamId")
    expect(config).toHaveProperty("linearTeamUuid")
    expect(config).toHaveProperty("linearWebhookSecret")
    expect(config).toHaveProperty("workflowStates")
    expect(config.workflowStates).toHaveProperty("todo")
    expect(config.workflowStates).toHaveProperty("inProgress")
    expect(config.workflowStates).toHaveProperty("done")
    expect(config.workflowStates).toHaveProperty("cancelled")
    expect(config).toHaveProperty("workspaceRoot")
    expect(config).toHaveProperty("agentType")
    expect(config).toHaveProperty("agentTimeout")
    expect(config).toHaveProperty("agentMaxRetries")
    expect(config).toHaveProperty("agentRetryDelay")
    expect(config).toHaveProperty("maxParallel")
    expect(config).toHaveProperty("serverPort")
    expect(config).toHaveProperty("logLevel")
    expect(config).toHaveProperty("logFormat")
  })

  test("returns correct types for numeric fields", () => {
    const config = toOrchestratorConfig()

    expect(typeof config.agentTimeout).toBe("number")
    expect(typeof config.agentMaxRetries).toBe("number")
    expect(typeof config.agentRetryDelay).toBe("number")
    expect(typeof config.maxParallel).toBe("number")
    expect(typeof config.serverPort).toBe("number")
  })

  test("agentType is a valid enum value", () => {
    const config = toOrchestratorConfig()
    expect(["claude", "codex", "gemini"]).toContain(config.agentType)
  })
})
