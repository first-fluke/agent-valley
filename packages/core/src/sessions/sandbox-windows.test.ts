import { describe, expect, test } from "vitest"
import { planSandboxedSpawn } from "./sandbox"
import type { SandboxBuildRequest } from "./sandbox-types"
import {
  buildWindowsSandboxCommand,
  getWindowsCredentialDenylist,
  isWindowsSandboxAvailable,
  resetWindowsSandboxCache,
  resolveWindowsSandboxPath,
} from "./sandbox-windows"

const BASE_REQUEST: SandboxBuildRequest = {
  agentType: "claude",
  command: "claude",
  args: ["--print", "hello"],
  workspacePath: "C:\\workspace\\issue-1",
  networkAllowlist: ["api.anthropic.com"],
}

describe("buildWindowsSandboxCommand", () => {
  test("wraps the target command with powershell.exe and isolation script", () => {
    const cmd = buildWindowsSandboxCommand(BASE_REQUEST, "powershell.exe", "C:\\Users\\alice")
    expect(cmd.command).toBe("powershell.exe")
    expect(cmd.args).toContain("-NoProfile")
    expect(cmd.args).toContain("-NonInteractive")
    expect(cmd.args).toContain("-ExecutionPolicy")
    expect(cmd.args).toContain("Bypass")
    expect(cmd.args).toContain("-Command")
    expect(cmd.args).toContain("C:\\workspace\\issue-1")
    expect(cmd.args).toContain("claude")
    expect(cmd.args).toContain("--print")
    expect(cmd.args).toContain("hello")
  })

  test("computes Windows credential denylist covering settings, ssh, and git-credentials", () => {
    const denylist = getWindowsCredentialDenylist(
      "C:\\Users\\alice",
      ["C:\\Users\\alice\\.codex"],
      "C:\\workspace\\issue-1",
    )
    expect(denylist.dirs.some((d) => d.includes(".config") && d.includes("agent-valley"))).toBe(true)
    expect(denylist.dirs.some((d) => d.includes(".ssh"))).toBe(true)
    expect(denylist.dirs.some((d) => d.includes(".codex"))).toBe(true)
    expect(denylist.files.some((f) => f.includes(".git-credentials"))).toBe(true)
  })
})

describe("isWindowsSandboxAvailable & resolveWindowsSandboxPath", () => {
  test.runIf(process.platform === "win32")("resolves a path on win32 and caches the result", async () => {
    resetWindowsSandboxCache()
    const path = await resolveWindowsSandboxPath()
    expect(path).toBeTruthy()
    const available = await isWindowsSandboxAvailable()
    expect(available).toBe(true)
  })

  test("returns consistent availability matching resolved path", async () => {
    resetWindowsSandboxCache()
    const path = await resolveWindowsSandboxPath()
    const available = await isWindowsSandboxAvailable()
    expect(available).toBe(path !== null)
  })
})

describe("planSandboxedSpawn on win32", () => {
  test("produces a sandboxed plan when powershell is available", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "win32",
      env: {},
      checkAvailable: async () => true,
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.platform).toBe("win32")
    expect(plan.command).toBe("powershell.exe")
    expect(plan.args).toContain("claude")
  })

  test("fails closed when sandbox check returns false and no opt-in", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "win32",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/powershell\.exe/)
  })

  test("allows unsandboxed fallback on win32 when SYMPHONY_ALLOW_UNSANDBOXED=1", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "win32",
      env: { SYMPHONY_ALLOW_UNSANDBOXED: "1" },
      checkAvailable: async () => false,
    })
    expect(plan.sandboxed).toBe(false)
    expect(plan.command).toBe("claude")
    expect(plan.args).toEqual(["--print", "hello"])
  })
})
