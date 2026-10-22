import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildAgentEnv } from "./base-session"
import { agentHomeAccess } from "./sandbox-agent-paths"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"
import { buildLinuxSandboxCommand } from "./sandbox-linux"

let directory: string
let home: string
let profile: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "av-codex-home-")))
  home = join(directory, "user")
  profile = join(home, "Library", "Application Support", "orca", "account", "home")
  mkdirSync(profile, { recursive: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe("Codex sandbox profile access", () => {
  it("grants the effective Codex home and masks the unused default", () => {
    const access = agentHomeAccess("codex", home, { CODEX_HOME: profile })
    expect(access.active).toEqual([profile])
    expect(access.inactive).toContain(join(home, ".codex"))
    expect(access.inactive).toContain(join(home, ".claude"))
  })

  it("retains the default profile when no custom home reaches the child", () => {
    vi.stubEnv("CODEX_HOME", profile)
    expect(agentHomeAccess("codex", home, {}).active).toEqual([join(home, ".codex")])
    expect(agentHomeAccess("codex", home).active).toEqual([join(home, ".codex")])
    expect(agentHomeAccess("claude", home, { CODEX_HOME: profile }).active).toEqual([join(home, ".claude")])
  })

  it("resolves the selected profile to a canonical directory", () => {
    const alias = join(home, "codex-alias")
    symlinkSync(profile, alias, "dir")
    expect(agentHomeAccess("codex", home, { CODEX_HOME: alias }).active).toEqual([profile])
  })

  it.each(["/", "relative/profile", "~/.codex", ""])("rejects unsafe custom path %j with remediation", (path) => {
    expect(() => agentHomeAccess("codex", home, { CODEX_HOME: path })).toThrow("CODEX_HOME")
  })

  it("rejects the entire home, its ancestors and symlink aliases to them", () => {
    for (const path of [home, dirname(home)])
      expect(() => agentHomeAccess("codex", home, { CODEX_HOME: path })).toThrow("dedicated")
    const alias = join(directory, "broad-home-alias")
    symlinkSync(home, alias, "dir")
    expect(() => agentHomeAccess("codex", home, { CODEX_HOME: alias })).toThrow("dedicated")
    const dottedHome = join(directory, "..user")
    mkdirSync(dottedHome)
    expect(() => agentHomeAccess("codex", dottedHome, { CODEX_HOME: directory })).toThrow("dedicated")
  })

  it("requires an existing directory rather than granting a file or an unresolved path", () => {
    const file = join(directory, "profile-file")
    writeFileSync(file, "not a directory")
    for (const path of [file, join(home, "missing-profile")])
      expect(() => agentHomeAccess("codex", home, { CODEX_HOME: path })).toThrow("Create")
  })
})

describe("sandbox composition uses the child environment", () => {
  const request = () => ({
    agentType: "codex",
    command: "codex",
    args: ["exec", "test"],
    workspacePath: join(directory, "workspace"),
    networkAllowlist: [],
  })

  it.each(["darwin", "linux"] as const)("grants only forwarded custom CODEX_HOME on %s", (platform) => {
    vi.stubEnv("CODEX_HOME", join(home, "ambient-unused-home"))
    const effective = buildAgentEnv("codex", { CODEX_HOME: profile }, {})
    const build = platform === "darwin" ? buildDarwinSandboxCommand : buildLinuxSandboxCommand
    const planned = build({ ...request(), env: effective }, undefined, home)
    const serialized = planned.args.join("\n")
    if (platform === "darwin") expect(serialized).toContain(`(allow file-write* (subpath ${JSON.stringify(profile)}))`)
    else expect(planned.args).toContain(profile)
    expect(serialized).not.toContain("ambient-unused-home")
  })

  it.each(["darwin", "linux"] as const)("does not widen %s access from unforwarded host variables", (platform) => {
    vi.stubEnv("CODEX_HOME", profile)
    const build = platform === "darwin" ? buildDarwinSandboxCommand : buildLinuxSandboxCommand
    const planned = build({ ...request(), env: buildAgentEnv("codex", {}, {}) }, undefined, home)
    const serialized = planned.args.join("\n")
    expect(serialized).not.toContain(profile)
    expect(serialized).toContain(join(home, ".codex"))
  })
})
