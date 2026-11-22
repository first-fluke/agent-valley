import { describe, expect, it, vi } from "vitest"
import { discoverAgents } from "../agent-discovery"

const NOW = 2_000_000_000_000
const SECRET = "test-only-credential-do-not-disclose"
const AUTH = "/home/test/.grok/auth.json"

async function grok(files: Record<string, unknown>) {
  const probe = vi.fn(async () => ({ exitCode: 0, stdout: "Usage: grok", stderr: "" }))
  const results = await discoverAgents({
    home: "/home/test",
    env: {},
    now: () => NOW,
    resolveBinary: (name) => (name === "grok" ? "/bin/grok" : null),
    isExecutableFile: () => true,
    fileInfo: (path) => (Object.hasOwn(files, path) ? { isFile: true, size: 100 } : null),
    readFile: (path) => JSON.stringify(files[path]),
    probe,
  })
  const result = results.find((entry) => entry.agentType === "grok")
  if (!result) throw new Error("Expected Grok discovery")
  expect(JSON.stringify(results)).not.toContain(SECRET)
  return result
}

describe("Grok Actor discovery", () => {
  it("reports a saved login that renews itself as ready", async () => {
    const login = { key: SECRET, refresh_token: SECRET, expires_at: new Date(NOW - 1_000).toISOString() }
    expect(await grok({ [AUTH]: { "https://auth.x.ai::client": login } })).toMatchObject({
      readiness: "ready",
      reason: "Grok native login found",
    })
  })

  it("reports an unexpired login without a refresh token as ready", async () => {
    const login = { key: SECRET, expires_at: new Date(NOW + 60_000).toISOString() }
    expect((await grok({ [AUTH]: { issuer: login } })).readiness).toBe("ready")
  })

  it("reports an expired login that cannot renew itself as unauthenticated", async () => {
    const login = { key: SECRET, expires_at: new Date(NOW - 1_000).toISOString() }
    const result = await grok({ [AUTH]: { issuer: login } })
    expect(result.readiness).toBe("unauthenticated")
    expect(result.reason).toContain("Grok login has expired")
  })

  it("reports an authentication file without a login as unauthenticated", async () => {
    expect((await grok({ [AUTH]: {} })).readiness).toBe("unauthenticated")
  })

  it("leaves authentication unverified when no authentication file exists", async () => {
    expect((await grok({})).readiness).toBe("unknown")
  })
})
