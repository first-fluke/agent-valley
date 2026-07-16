/**
 * sandbox.test.ts — Sandbox command construction + fail-closed/opt-in gating.
 *
 * Mocks platform + binary availability throughout — never requires the
 * real sandbox-exec/bwrap binaries to be installed to run.
 */

import { existsSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { logger } from "../observability/logger"
import {
  ALLOW_UNSANDBOXED_ENV_VAR,
  DEFAULT_NETWORK_ALLOWLIST,
  isUnsandboxedFallbackAllowed,
  NETWORK_ALLOWLIST_ENV_VAR,
  planSandboxedSpawn,
  resolveNetworkAllowlist,
} from "./sandbox"
import { resolveBinaryPath } from "./sandbox-binary"
import { buildDarwinSandboxCommand, resetSandboxExecCache } from "./sandbox-darwin"
import { buildLinuxSandboxCommand, resetBwrapCache } from "./sandbox-linux"

const BASE_REQUEST = {
  agentType: "claude",
  command: "claude",
  args: ["--print", "--dangerously-skip-permissions"],
  workspacePath: "/workspaces/ACR-42",
}

describe("resolveNetworkAllowlist", () => {
  test("returns the default allowlist when no env override is set", () => {
    expect(resolveNetworkAllowlist({})).toEqual([...DEFAULT_NETWORK_ALLOWLIST])
  })

  test("merges operator-configured extra domains, de-duplicated", () => {
    const result = resolveNetworkAllowlist({
      [NETWORK_ALLOWLIST_ENV_VAR]: "internal.example.com, api.anthropic.com , second.example.com",
    })
    expect(result).toContain("internal.example.com")
    expect(result).toContain("second.example.com")
    expect(result.filter((d) => d === "api.anthropic.com")).toHaveLength(1)
  })
})

describe("isUnsandboxedFallbackAllowed", () => {
  test("false by default (fail-closed default)", () => {
    expect(isUnsandboxedFallbackAllowed({})).toBe(false)
  })

  test("false for any value other than the literal '1'", () => {
    expect(isUnsandboxedFallbackAllowed({ [ALLOW_UNSANDBOXED_ENV_VAR]: "true" })).toBe(false)
  })

  test("true only when explicitly set to '1'", () => {
    expect(isUnsandboxedFallbackAllowed({ [ALLOW_UNSANDBOXED_ENV_VAR]: "1" })).toBe(true)
  })
})

describe("sandbox-binary resolveBinaryPath", () => {
  test("finds a binary via an absolute candidate path", () => {
    expect(resolveBinaryPath("sh", ["/bin/sh"])).toBe("/bin/sh")
  })

  test("returns null for a binary that does not exist anywhere", () => {
    expect(
      resolveBinaryPath("definitely-not-a-real-binary-xyz-123", ["/nowhere/definitely-not-a-real-binary-xyz-123"]),
    ).toBeNull()
  })
})

describe("buildDarwinSandboxCommand", () => {
  test("wraps the base command in sandbox-exec with a Seatbelt profile", () => {
    const result = buildDarwinSandboxCommand(
      { ...BASE_REQUEST, networkAllowlist: ["api.anthropic.com"] },
      "/usr/bin/sandbox-exec",
    )
    expect(result.command).toBe("/usr/bin/sandbox-exec")
    expect(result.args[0]).toBe("-p")
    const profile = result.args[1] as string
    expect(profile).toContain("(deny default)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain(BASE_REQUEST.workspacePath)
    // Domain-scoped `(remote tcp "host:port")` rules crash sandbox-exec on
    // current macOS ("host must be * or localhost in network address") —
    // verified empirically. The profile must therefore only ever emit
    // wildcard-host, port-scoped network rules, never a literal hostname.
    expect(profile).not.toMatch(/remote tcp "[a-zA-Z]/)
    expect(profile).toContain('(remote tcp "*:443")')
    expect(profile).toContain('(remote tcp "*:80")')
    // Original command + args are appended after the profile.
    expect(result.args.slice(2)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("escapes quotes in paths so the profile stays syntactically valid", () => {
    const result = buildDarwinSandboxCommand(
      { ...BASE_REQUEST, workspacePath: '/workspaces/weird"path', networkAllowlist: [] },
      "/usr/bin/sandbox-exec",
    )
    const profile = result.args[1] as string
    expect(profile).toContain('\\"path')
  })
})

describe("buildLinuxSandboxCommand", () => {
  test("binds the workspace read-write and appends the base command at the tail", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    expect(result.command).toBe("bwrap")
    expect(result.args).toContain("--bind-try")
    const wsIndex = result.args.indexOf(BASE_REQUEST.workspacePath)
    expect(wsIndex).toBeGreaterThan(-1)
    expect(result.args[wsIndex - 1]).toBe("--bind-try")
    // Original command + args are appended after a bare "--" separator.
    const sepIndex = result.args.indexOf("--")
    expect(sepIndex).toBeGreaterThan(-1)
    expect(result.args.slice(sepIndex + 1)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("only ro-binds root directories that actually exist on this host", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const roBindTargets = result.args.filter(
      (_, i) => result.args[i - 1] === "--ro-bind" && result.args[i - 2] !== "--ro-bind",
    )
    for (const target of roBindTargets) {
      if (typeof target === "string" && target.startsWith("/")) {
        expect(existsSync(target)).toBe(true)
      }
    }
  })
})

describe("planSandboxedSpawn", () => {
  beforeEach(() => {
    resetSandboxExecCache()
    resetBwrapCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("darwin + sandbox available: wraps the spawn and reports sandboxed=true", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "darwin",
      env: {},
      checkAvailable: async () => true,
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.platform).toBe("darwin")
    expect(plan.command).toBe("/usr/bin/sandbox-exec")
    expect(plan.args.slice(-BASE_REQUEST.args.length - 1)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("linux + sandbox available: wraps via bwrap and warns about the network gap", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "linux",
      env: {},
      checkAvailable: async () => true,
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.command).toBe("bwrap")
    expect(warnSpy).toHaveBeenCalledWith(
      "sessions.sandbox",
      expect.stringContaining("network egress is NOT domain-restricted"),
      expect.objectContaining({ agentType: "claude" }),
    )
  })

  test("darwin + no sandbox binary + no opt-in: fails closed with an actionable error", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "darwin",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/sandbox-exec/)
  })

  test("fail-closed error names the opt-in env var and the fix", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "linux",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(new RegExp(`bwrap.*${ALLOW_UNSANDBOXED_ENV_VAR}=1`, "s"))
  })

  test("unsupported platform + no opt-in: fails closed and names the platform", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "win32",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/win32/)
  })

  test("opt-in gate: SYMPHONY_ALLOW_UNSANDBOXED=1 allows a loud, unsandboxed fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "linux",
      env: { [ALLOW_UNSANDBOXED_ENV_VAR]: "1" },
      checkAvailable: async () => false,
    })
    expect(plan.sandboxed).toBe(false)
    expect(plan.command).toBe(BASE_REQUEST.command)
    expect(plan.args).toEqual(BASE_REQUEST.args)
    expect(warnSpy).toHaveBeenCalledWith(
      "sessions.sandbox",
      expect.stringContaining("WITHOUT an OS sandbox"),
      expect.objectContaining({ agentType: "claude", platform: "linux" }),
    )
  })

  test("opt-in gate rejects any value other than '1'", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "darwin",
        env: { [ALLOW_UNSANDBOXED_ENV_VAR]: "yes" },
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/sandbox-exec/)
  })

  test("network allowlist passed through the plan reflects env overrides", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "darwin",
      env: { [NETWORK_ALLOWLIST_ENV_VAR]: "custom.example.com" },
      checkAvailable: async () => true,
    })
    expect(plan.networkAllowlist).toContain("custom.example.com")
    expect(plan.networkAllowlist).toContain("api.anthropic.com")
  })
})
