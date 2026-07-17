/**
 * `av up` / `av dev` webhook auto-registration wiring tests.
 *
 * Covered behaviours:
 *   - calls upsertWebhook with the tunnel URL + /api/webhook when trackerKind === "linear"
 *   - skips (no call) when trackerKind === "github"
 *   - swallows upsertWebhook failures as a console WARN instead of throwing
 *   - swallows loadConfig failures as a console WARN instead of throwing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type AnyFn = (...args: unknown[]) => unknown

const state: {
  loadConfigImpl: () => unknown
  upsertWebhookMock: AnyFn
} = {
  loadConfigImpl: () => ({
    trackerKind: "linear",
    linearApiKey: "lin_api_test",
    linearTeamUuid: "team-uuid-1",
    linearWebhookSecret: "s3cr3t",
  }),
  upsertWebhookMock: vi.fn(),
}

vi.mock("@agent-valley/core/config/yaml-loader", () => ({
  loadConfig: (...args: unknown[]) => state.loadConfigImpl.apply(null, args as []),
}))

vi.mock("@agent-valley/core/tracker/linear-client", () => ({
  upsertWebhook: (...args: unknown[]) => state.upsertWebhookMock(...args),
}))

import { registerLinearWebhook } from "../linear-webhook-register"

/** Minimal shape we need from `vi.spyOn(console, "log")`, typed loosely to
 * sidestep vitest's overload-heavy `MockInstance` generics in test code. */
interface LogSpy {
  mock: { calls: unknown[][] }
  mockRestore: () => void
}

describe("registerLinearWebhook", () => {
  let logSpy: LogSpy

  beforeEach(() => {
    state.upsertWebhookMock = vi.fn().mockResolvedValue({ id: "wh-1", url: "https://tunnel.example/api/webhook" })
    state.loadConfigImpl = () => ({
      trackerKind: "linear",
      linearApiKey: "lin_api_test",
      linearTeamUuid: "team-uuid-1",
      linearWebhookSecret: "s3cr3t",
    })
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as LogSpy
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("calls upsertWebhook with the tunnel URL + /api/webhook in Linear mode", async () => {
    await registerLinearWebhook("/project/root", "https://tunnel.example")

    expect(state.upsertWebhookMock).toHaveBeenCalledWith({
      apiKey: "lin_api_test",
      teamId: "team-uuid-1",
      url: "https://tunnel.example/api/webhook",
      secret: "s3cr3t",
    })
  })

  it("skips registration in GitHub mode without calling upsertWebhook", async () => {
    state.loadConfigImpl = () => ({ trackerKind: "github" })

    await registerLinearWebhook("/project/root", "https://tunnel.example")

    expect(state.upsertWebhookMock).not.toHaveBeenCalled()
  })

  it("logs a WARN and does not throw when upsertWebhook fails", async () => {
    state.upsertWebhookMock = vi.fn().mockRejectedValue(new Error("Linear API key lacks permission to create webhooks"))

    await expect(registerLinearWebhook("/project/root", "https://tunnel.example")).resolves.toBeUndefined()

    const calls: unknown[][] = logSpy.mock.calls
    const warned = calls.some((call) => String(call[0]).includes("Could not auto-register Linear webhook"))
    expect(warned).toBe(true)
  })

  it("logs a WARN and does not throw when loadConfig fails", async () => {
    state.loadConfigImpl = () => {
      throw new Error("valley.yaml not found")
    }

    await expect(registerLinearWebhook("/project/root", "https://tunnel.example")).resolves.toBeUndefined()

    expect(state.upsertWebhookMock).not.toHaveBeenCalled()
    const calls: unknown[][] = logSpy.mock.calls
    const warned = calls.some((call) => String(call[0]).includes("Skipped Linear webhook registration"))
    expect(warned).toBe(true)
  })

  it("never logs the webhook secret", async () => {
    await registerLinearWebhook("/project/root", "https://tunnel.example")

    const calls: unknown[][] = logSpy.mock.calls
    const loggedText = calls.map((call) => String(call[0])).join("\n")
    expect(loggedText).not.toContain("s3cr3t")
  })
})
