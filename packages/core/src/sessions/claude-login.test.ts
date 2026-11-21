import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  type ClaudeLoginDeps,
  claudeKeychainService,
  claudeLoginExpiry,
  keepClaudeLoginFresh,
  REFRESH_LEAD_MS,
  refreshClaudeLogin,
} from "./claude-login"

const HOUR = 3_600_000
const START = Date.UTC(2026, 10, 21, 14, 0, 0)

/** A host whose keychain holds a login; an unsandboxed claude call moves the expiry when `refreshes`. */
function host(expiresAt: number | null, refreshes = true) {
  const calls: string[] = []
  const state = { expiresAt }
  const deps: ClaudeLoginDeps = {
    now: () => Date.now(),
    run: async (command, args) => {
      calls.push(command)
      if (command === "/usr/bin/security") {
        expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        if (state.expiresAt === null) return null
        return JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: state.expiresAt } })
      }
      if (refreshes) state.expiresAt = Date.now() + 8 * HOUR
      return "OK\n"
    },
  }
  const claudeCalls = () => calls.filter((command) => command === "claude").length
  return { deps, state, claudeCalls }
}

describe("Claude login outside the sandbox", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test("names the keychain service of the default and of a selected profile", () => {
    expect(claudeKeychainService({})).toBe("Claude Code-credentials")
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/profiles/a" })).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/profiles/a" })).not.toBe(
      claudeKeychainService({ CLAUDE_CONFIG_DIR: "/profiles/b" }),
    )
  })

  test("reads the expiry, and reports no login for a missing or malformed entry", async () => {
    expect(await claudeLoginExpiry({}, host(START + HOUR).deps)).toBe(START + HOUR)
    expect(await claudeLoginExpiry({}, host(null).deps)).toBeNull()
    const malformed: ClaudeLoginDeps = { now: Date.now, run: async () => "not json" }
    expect(await claudeLoginExpiry({}, malformed)).toBeNull()
  })

  test("refreshes at once when the token expires within the lead time", async () => {
    const { deps, state, claudeCalls } = host(START + REFRESH_LEAD_MS - 1_000)
    const keeper = keepClaudeLoginFresh({}, deps)
    await keeper.ready
    expect(claudeCalls()).toBe(1)
    expect(state.expiresAt).toBe(START + 8 * HOUR)
    keeper.stop()
  })

  test("refreshes a running session's login at the lead time before the expiry", async () => {
    const { deps, state, claudeCalls } = host(START + HOUR)
    const keeper = keepClaudeLoginFresh({}, deps)
    await keeper.ready
    expect(claudeCalls()).toBe(0)
    await vi.advanceTimersByTimeAsync(HOUR - REFRESH_LEAD_MS - 1_000)
    expect(claudeCalls()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(claudeCalls()).toBe(1)
    expect(state.expiresAt).toBeGreaterThan(START + 8 * HOUR)
    keeper.stop()
  })

  test("makes no call after the session ends", async () => {
    const { deps, claudeCalls } = host(START + HOUR)
    const keeper = keepClaudeLoginFresh({}, deps)
    await keeper.ready
    keeper.stop()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(claudeCalls()).toBe(0)
  })

  test("leaves a session with its own credential alone", async () => {
    const { deps, claudeCalls } = host(START + 1_000)
    const run = vi.spyOn(deps, "run")
    const keeper = keepClaudeLoginFresh({ ANTHROPIC_API_KEY: "key" }, deps)
    await keeper.ready
    expect(run).not.toHaveBeenCalled()
    expect(claudeCalls()).toBe(0)
  })

  test("shares one refresh between sessions that reach the expiry together", async () => {
    const { deps, claudeCalls } = host(START + 1_000)
    const results = await Promise.all([refreshClaudeLogin({}, deps), refreshClaudeLogin({}, deps)])
    expect(results).toEqual([true, true])
    expect(claudeCalls()).toBe(1)
  })

  test("gives up after three refreshes that do not move the expiry", async () => {
    const { deps, claudeCalls } = host(START + 1_000, false)
    const keeper = keepClaudeLoginFresh({}, deps)
    await keeper.ready
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(claudeCalls()).toBe(3)
    keeper.stop()
  })
})
