import { describe, expect, it, vi } from "vitest"
import type { AgentConfig } from "./agent-session"
import { FreellmSession, resolveFreellmSettings } from "./freellm-session"

describe("FreellmSession settings resolution", () => {
  it("resolves defaults when only FREELLM_API_KEY is provided", () => {
    const settings = resolveFreellmSettings(undefined, { FREELLM_API_KEY: "test-key-123" })
    expect(settings.baseUrl).toBe("http://127.0.0.1:31415/v1")
    expect(settings.apiKey).toBe("test-key-123")
    expect(settings.model).toBe("auto")
  })

  it("supports FREELLMAPI_API_KEY as an alternative environment key", () => {
    const settings = resolveFreellmSettings(undefined, { FREELLMAPI_API_KEY: "alt-key-456" })
    expect(settings.apiKey).toBe("alt-key-456")
  })

  it("normalizes base URL to ensure trailing /v1 without trailing slash", () => {
    const settings = resolveFreellmSettings(undefined, {
      FREELLM_API_KEY: "key",
      FREELLM_BASE_URL: "https://free.example.com/api/",
    })
    expect(settings.baseUrl).toBe("https://free.example.com/api/v1")
  })

  it("preserves base URL that already ends with /v1", () => {
    const settings = resolveFreellmSettings(undefined, {
      FREELLM_API_KEY: "key",
      FREELLM_BASE_URL: "http://localhost:8080/v1/",
    })
    expect(settings.baseUrl).toBe("http://localhost:8080/v1")
  })

  it("rejects invalid or unsafe base URLs", () => {
    expect(() =>
      resolveFreellmSettings(undefined, { FREELLM_API_KEY: "k", FREELLM_BASE_URL: "ftp://example.com" }),
    ).toThrow("HTTP(S)")
    expect(() =>
      resolveFreellmSettings(undefined, { FREELLM_API_KEY: "k", FREELLM_BASE_URL: "http://user:pass@localhost" }),
    ).toThrow("without credentials")
  })

  it("rejects missing API key with actionable instructions", () => {
    expect(() => resolveFreellmSettings(undefined, {})).toThrow("FREELLM_API_KEY")
  })

  it("rejects API keys with control characters", () => {
    expect(() => resolveFreellmSettings(undefined, { FREELLM_API_KEY: "key\nwith\rnewline" })).toThrow(
      "invalid characters",
    )
  })

  it("prioritizes config.model over FREELLM_MODEL env", () => {
    const config: AgentConfig = {
      type: "freellm",
      model: "custom/fast-model",
      timeout: 60,
      workspacePath: "/tmp",
    }
    const settings = resolveFreellmSettings(config, {
      FREELLM_API_KEY: "key",
      FREELLM_MODEL: "env/model",
    })
    expect(settings.model).toBe("custom/fast-model")
  })
})

describe("FreellmSession invocation configuration", () => {
  it("emits AUTH_FAILED when started without credentials", async () => {
    const session = new FreellmSession()
    const errorHandler = vi.fn()
    session.on("error", errorHandler)
    const config: AgentConfig = {
      type: "freellm",
      timeout: 30,
      workspacePath: "/tmp",
      env: {},
    }

    await expect(session.start(config)).rejects.toThrow("FREELLM_API_KEY")
    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "AUTH_FAILED" }),
      }),
    )
  })
})
