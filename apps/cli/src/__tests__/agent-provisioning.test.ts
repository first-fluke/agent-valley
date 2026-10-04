import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AgentAvailability, supportsNativeLoginCommand } from "../agent-discovery"
import {
  AGENT_PROVISIONING,
  inspectChiefAgent,
  installChiefAgent,
  loginChiefAgent,
  type ProvisioningDeps,
  runTerminalCommand,
  type TerminalCommand,
} from "../agent-provisioning"
import type { AgentType } from "../doctor-checks"

const SECRET = "test-only-secret-must-not-be-captured"

function state(agent: AgentType, readiness: AgentAvailability["readiness"] = "unknown"): AgentAvailability {
  return { agentType: agent, binaryPath: `/fixture/${agent}`, readiness, reason: "Fixture status" }
}

function deps(agent: AgentType = "claude", overrides: Partial<ProvisioningDeps> = {}): ProvisioningDeps {
  return {
    platform: "darwin",
    home: "/fixture/home",
    env: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    resolveBinary: (name) => `/fixture/bin/${name}`,
    discover: async () => [state(agent)],
    runCommand: vi.fn(async () => ({ success: true })),
    supportsLoginCommand: async () => true,
    makeTempDir: vi.fn(() => "/fixture/private-temp"),
    removeTempDir: vi.fn(),
    ...overrides,
  }
}

afterEach(() => vi.useRealTimers())

describe("Chief Director provisioning", () => {
  it.each([
    ["claude", "@anthropic-ai/claude-code"],
    ["codex", "@openai/codex"],
    ["qwen", "@qwen-code/qwen-code"],
    ["grok", "@xai-official/grok"],
    ["kimi", "@moonshot-ai/kimi-code"],
    ["opencode", "opencode-ai"],
  ] as const)("installs %s using the fixed official package argv", async (agent, packageName) => {
    const injected = deps(agent)
    expect((await installChiefAgent(agent, injected)).success).toBe(true)
    expect(injected.runCommand).toHaveBeenCalledExactlyOnceWith({
      command: "/fixture/bin/npm",
      args: ["install", "--global", packageName],
      env: injected.env,
      timeoutMs: 300_000,
    })
  })

  it.each(["cursor", "antigravity"] as const)(
    "downloads %s's fixed HTTPS installer and invokes a private script without a shell expression",
    async (agent) => {
      const injected = deps(agent)
      expect((await installChiefAgent(agent, injected)).success).toBe(true)
      const run = vi.mocked(injected.runCommand)
      expect(run).toHaveBeenCalledTimes(2)
      const download = run.mock.calls[0]?.[0]
      expect(download?.command).toBe("/fixture/bin/curl")
      expect(download?.args.at(-1)).toBe(AGENT_PROVISIONING[agent].installerUrl)
      expect(download?.args).toContain("--max-time")
      expect(download?.args).toContain("--max-filesize")
      expect(run.mock.calls[1]?.[0]).toEqual({
        command: "/fixture/bin/bash",
        args: ["/fixture/private-temp/install.sh"],
        env: injected.env,
        timeoutMs: 300_000,
      })
      expect(injected.removeTempDir).toHaveBeenCalledWith("/fixture/private-temp")
      expect(injected.env.PATH?.startsWith("/fixture/home/.local/bin")).toBe(true)
    },
  )

  it("guides missing package-manager and Windows native-script prerequisites without running unsupported installers", async () => {
    const injected = deps("claude", { resolveBinary: () => null })
    expect((await installChiefAgent("claude", injected)).message).toContain("Node.js 26")
    expect(injected.runCommand).not.toHaveBeenCalled()
    const windows = deps("cursor", { platform: "win32" })
    expect((await installChiefAgent("cursor", windows)).message).toContain("Windows or WSL")
    expect(windows.runCommand).not.toHaveBeenCalled()
  })

  it("does not execute a failed download and always removes the installer workspace", async () => {
    const injected = deps("cursor", {
      runCommand: vi.fn(async () => ({ success: false, failure: "timed_out" as const })),
    })
    const result = await installChiefAgent("cursor", injected)
    expect(result.success).toBe(false)
    expect(result.message).toContain("timed out")
    expect(injected.runCommand).toHaveBeenCalledTimes(1)
    expect(injected.removeTempDir).toHaveBeenCalledOnce()
  })

  it("redacts installer exceptions and does not claim successful install", async () => {
    const injected = deps("codex", {
      runCommand: vi.fn(async () => {
        throw new Error(SECRET)
      }),
    })
    const result = await installChiefAgent("codex", injected)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.message).toContain("Retry")
  })

  it.each([
    ["claude", ["auth", "login"]],
    ["codex", ["login"]],
    ["cursor", ["login"]],
    ["grok", ["login"]],
    ["opencode", ["auth", "login"]],
    ["kimi", []],
    ["qwen", []],
    ["antigravity", []],
  ] as const)(
    "uses only documented native %s login arguments with inherited-session environment",
    async (agent, args) => {
      const injected = deps(agent, {
        env: { HOME: "/fixture/home", PATH: "/bin", UNSAFE_SECRET: SECRET, CODEX_HOME: "/codex-profile" },
      })
      const result = await loginChiefAgent(agent, injected)
      expect(result.success).toBe(true)
      expect(result.message).toContain("checked again")
      expect(JSON.stringify(result)).not.toContain(SECRET)
      const request = vi.mocked(injected.runCommand).mock.calls[0]?.[0]
      expect(request?.args).toEqual(args)
      expect(request?.command).toBe(`/fixture/${agent}`)
      expect(request?.env.UNSAFE_SECRET).toBeUndefined()
      expect(request?.timeoutMs).toBe(900_000)
      if (agent === "codex") expect(request?.env.CODEX_HOME).toBe("/codex-profile")
    },
  )

  it("does not start login on missing CLIs or unadvertised authentication commands", async () => {
    const unavailable = deps("claude", { discover: async () => [state("claude", "unavailable")] })
    expect((await loginChiefAgent("claude", unavailable)).success).toBe(false)
    expect(unavailable.runCommand).not.toHaveBeenCalled()
    const legacy = deps("claude", { supportsLoginCommand: async () => false })
    expect((await loginChiefAgent("claude", legacy)).message).toContain("does not advertise")
    expect(legacy.runCommand).not.toHaveBeenCalled()
  })

  it("reports a missing discovery result as unknown", async () => {
    expect((await inspectChiefAgent("claude", deps("claude", { discover: async () => [] }))).readiness).toBe("unknown")
  })
})

describe("login command verification", () => {
  it.each(["claude", "codex", "cursor", "grok", "opencode"] as const)(
    "verifies advertised %s login without running it",
    async (agent) => {
      const probe = vi.fn(async (_path: string, args: readonly string[]) => ({
        exitCode: 0,
        stdout:
          args.length > 1
            ? "Commands:\n  login Sign in"
            : `Commands:\n  ${agent === "claude" || agent === "opencode" ? "auth" : "login"} Auth`,
        stderr: "",
      }))
      expect(await supportsNativeLoginCommand(agent, "/fixture/cli", { env: {}, probe })).toBe(true)
      expect(probe.mock.calls.every((call) => call[1].includes("--help"))).toBe(true)
    },
  )

  it("rejects missing auth groups, missing login subcommands, errors, and unsupported TUI auth", async () => {
    for (const stdout of ["Commands:\n  chat Run prompt", "Commands:\n  auth Authentication"]) {
      const probe = vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" }))
      expect(await supportsNativeLoginCommand("claude", "/fixture/cli", { env: {}, probe })).toBe(false)
    }
    const failing = vi.fn(async () => {
      throw new Error(SECRET)
    })
    expect(await supportsNativeLoginCommand("codex", "/fixture/cli", { env: {}, probe: failing })).toBe(false)
    expect(await supportsNativeLoginCommand("antigravity", "/fixture/cli", { env: {}, probe: failing })).toBe(false)
  })
})

describe("native terminal command adapter", () => {
  const command: TerminalCommand = { command: "/fixture/cli", args: ["login"], env: {}, timeoutMs: 10_000 }

  function processFixture() {
    const proc = new EventEmitter() as ChildProcess
    proc.kill = vi.fn(() => true)
    const spawnMock = vi.fn(() => proc)
    return { proc, spawnMock, spawnCommand: spawnMock as unknown as typeof spawn }
  }

  it("inherits all terminal streams, disables shell evaluation, and resolves native success", async () => {
    const fake = processFixture()
    const pending = runTerminalCommand(command, fake.spawnCommand)
    expect(fake.spawnMock).toHaveBeenCalledExactlyOnceWith(command.command, ["login"], {
      stdio: "inherit",
      env: {},
      shell: false,
    })
    fake.proc.emit("close", 0)
    expect(await pending).toEqual({ success: true })
  })

  it("returns a bounded timeout even if a child ignores termination", async () => {
    vi.useFakeTimers()
    const fake = processFixture()
    const pending = runTerminalCommand(command, fake.spawnCommand)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(fake.proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM")
    expect(fake.proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL")
    expect(await pending).toEqual({ success: false, failure: "timed_out" })
  })

  it("runs an installation in the explicitly selected workspace", async () => {
    const fake = processFixture()
    const pending = runTerminalCommand({ ...command, cwd: "/fixture/selected-workspace" }, fake.spawnCommand)
    expect(fake.spawnMock).toHaveBeenCalledWith(command.command, ["login"], {
      stdio: "inherit",
      env: {},
      shell: false,
      cwd: "/fixture/selected-workspace",
    })
    fake.proc.emit("close", 0)
    expect(await pending).toEqual({ success: true })
  })

  it("redacts asynchronous and synchronous spawn errors", async () => {
    const fake = processFixture()
    const pending = runTerminalCommand(command, fake.spawnCommand)
    fake.proc.emit("error", new Error(SECRET))
    expect(await pending).toEqual({ success: false, failure: "failed" })
    const throwing = vi.fn(() => {
      throw new Error(SECRET)
    }) as unknown as typeof spawn
    expect(await runTerminalCommand(command, throwing)).toEqual({ success: false, failure: "failed" })
  })
})
