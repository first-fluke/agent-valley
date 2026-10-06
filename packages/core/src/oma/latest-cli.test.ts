import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureLatestOmaCli, type OmaLatestCliIO, parseOmaCliVersion } from "./latest-cli"

const native = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: native.spawn }))

function fixture(installed: string | null = "15.7.1", latest = "15.7.1") {
  let current = installed
  const io: OmaLatestCliIO = {
    run: vi.fn(async (command, args) => {
      if (command === "oma") return { exitCode: current ? 0 : 1, stdout: current ?? "" }
      if (args[0] === "view") return { exitCode: 0, stdout: JSON.stringify(latest) }
      current = latest
      return { exitCode: 0, stdout: "Installed fixture CLI" }
    }),
  }
  return { io, setLatest: (version: string) => (latest = version) }
}

function processFixture(stdout: string, exitCode = 0, hang = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  if (!hang)
    queueMicrotask(() => {
      child.stdout.write(stdout)
      child.emit("close", exitCode)
    })
  return child as unknown as ChildProcess
}

beforeEach(() => native.spawn.mockReset())
afterEach(() => vi.useRealTimers())

describe("latest OMA CLI preparation", () => {
  it.each(["15.7.1", "16.0.0", "1.0.0-rc.2+build.3"])("parses a complete version %s", (version) => {
    expect(parseOmaCliVersion(` ${version}\n`)).toBe(version)
  })

  it("normalizes a harmless CLI prefix and bounds version metadata", () => {
    expect(parseOmaCliVersion(" v15.7.1\n")).toBe("15.7.1")
    expect(parseOmaCliVersion(`1.0.0+${"x".repeat(122)}`)).toBe(`1.0.0+${"x".repeat(122)}`)
    expect(parseOmaCliVersion(`1.0.0+${"x".repeat(123)}`)).toBeNull()
    expect(parseOmaCliVersion(`v1.0.0+${"x".repeat(122)}`)).toBeNull()
  })

  it.each(["", "OMA 15.7.1", "15.7", "015.7.1", "1.0.0-01", "15.7.1\n16.0.0"])(
    "rejects malformed version output %j",
    (value) => expect(parseOmaCliVersion(value)).toBeNull(),
  )

  it("resolves the latest tag without reinstalling an exact installed match", async () => {
    const { io } = fixture()
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "15.7.1", installed: false })
    expect(vi.mocked(io.run).mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["oma", ["--version"]],
      ["npm", ["view", "oh-my-agent@latest", "version", "--json", "--prefer-online"]],
    ])
    for (const [, , options] of vi.mocked(io.run).mock.calls) {
      expect(options.timeoutMs).toBeGreaterThan(0)
      expect(options.maxOutputBytes).toBe(1_048_576)
    }
  })

  it.each(["15.0.4", "17.0.0-rc.1", null])("installs and confirms latest when current is %j", async (current) => {
    const { io } = fixture(current)
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "15.7.1", installed: true })
    expect(vi.mocked(io.run).mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["oma", ["--version"]],
      ["npm", ["view", "oh-my-agent@latest", "version", "--json", "--prefer-online"]],
      ["npm", ["install", "--global", "--ignore-scripts", "oh-my-agent@latest"]],
      ["oma", ["--version"]],
    ])
  })

  it("handles a missing installed executable before installing the resolved latest", async () => {
    const { io } = fixture(null)
    vi.mocked(io.run).mockRejectedValueOnce(new Error("ENOENT"))
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "15.7.1", installed: true })
  })

  it.each(['"invalid"', "{}", '["15.7.1"]', "15.7.1", '"1.0.0-01"'])(
    "rejects malformed registry metadata %s without installing",
    async (metadata) => {
      const { io } = fixture()
      vi.mocked(io.run).mockImplementation(async (command) => ({
        exitCode: 0,
        stdout: command === "oma" ? "15.7.1" : metadata,
      }))
      await expect(ensureLatestOmaCli({ io })).rejects.toThrow("oh-my-agent@latest")
      expect(io.run).toHaveBeenCalledTimes(2)
    },
  )

  it("fails closed on a private registry failure without leaking command output", async () => {
    const { io } = fixture("15.0.4")
    vi.mocked(io.run).mockImplementation(async (command) => ({
      exitCode: command === "oma" ? 0 : 1,
      stdout: command === "oma" ? "15.0.4" : "fixture-private-registry-token",
      stderr: "fixture-private-registry-token",
    }))
    const result = ensureLatestOmaCli({ io })
    await expect(result).rejects.toThrow("registry lookup")
    await expect(result).rejects.not.toThrow("fixture-private-registry-token")
    expect(io.run).toHaveBeenCalledTimes(2)
  })

  it("reports installation failure without accepting the old CLI", async () => {
    const { io } = fixture("15.0.4")
    vi.mocked(io.run).mockImplementation(async (command, args) => ({
      exitCode: args[0] === "install" ? 1 : 0,
      stdout: command === "oma" ? "15.0.4" : '"15.7.1"',
    }))
    await expect(ensureLatestOmaCli({ io })).rejects.toThrow("installation")
    expect(io.run).toHaveBeenCalledTimes(3)
  })

  it.each(["15.0.4", "16.0.0", "invalid"])("rejects a post-install PATH mismatch %s", async (reported) => {
    const { io } = fixture("15.0.4")
    vi.mocked(io.run).mockImplementation(async (command, args) => ({
      exitCode: 0,
      stdout: command === "oma" ? reported : args[0] === "view" ? '"15.7.1"' : "installed",
    }))
    await expect(ensureLatestOmaCli({ io })).rejects.toThrow("Check PATH")
  })

  it("shares one in-flight install across concurrent strict starts", async () => {
    const { io } = fixture("15.0.4")
    const first = ensureLatestOmaCli({ io })
    const second = ensureLatestOmaCli({ io })
    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([
      { version: "15.7.1", installed: true },
      { version: "15.7.1", installed: true },
    ])
    expect(io.run).toHaveBeenCalledTimes(4)
  })

  it("refreshes registry selection for the next attempt in a long-lived process", async () => {
    const { io, setLatest } = fixture()
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "15.7.1", installed: false })
    setLatest("16.0.0")
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "16.0.0", installed: true })
    expect(io.run).toHaveBeenCalledTimes(6)
  })

  it("allows a fresh attempt after a failed registry probe", async () => {
    const { io } = fixture()
    vi.mocked(io.run).mockResolvedValueOnce({ exitCode: 0, stdout: "15.7.1" })
    vi.mocked(io.run).mockRejectedValueOnce(new Error("fixture temporary registry failure"))
    await expect(ensureLatestOmaCli({ io })).rejects.toThrow("registry lookup")
    await expect(ensureLatestOmaCli({ io })).resolves.toEqual({ version: "15.7.1", installed: false })
    expect(io.run).toHaveBeenCalledTimes(4)
  })

  it("uses bounded native argv without replacing authentication or home variables", async () => {
    native.spawn
      .mockImplementationOnce(() => processFixture("15.7.1"))
      .mockImplementationOnce(() => processFixture('"15.7.1"'))
    await expect(ensureLatestOmaCli()).resolves.toEqual({ version: "15.7.1", installed: false })
    expect(native.spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["oma", ["--version"]],
      ["npm", ["view", "oh-my-agent@latest", "version", "--json", "--prefer-online"]],
    ])
    expect(native.spawn.mock.calls.every(([, , options]) => options.env === undefined)).toBe(true)
    expect(native.spawn.mock.calls.every(([, , options]) => options.shell === undefined)).toBe(true)
  })

  it("kills a native registry probe at its deadline", async () => {
    vi.useFakeTimers()
    const hung = processFixture("", 0, true)
    native.spawn.mockImplementationOnce(() => processFixture("15.7.1")).mockReturnValueOnce(hung)
    const result = ensureLatestOmaCli()
    const rejected = expect(result).rejects.toThrow("registry lookup: request timed out")
    await vi.advanceTimersByTimeAsync(60_001)
    await rejected
    expect(hung.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("kills a native probe when its combined output exceeds the bound", async () => {
    const oversized = processFixture("", 0, true)
    native.spawn
      .mockImplementationOnce(() => processFixture("15.7.1"))
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          oversized.stdout?.emit("data", Buffer.alloc(524_288))
          oversized.stderr?.emit("data", Buffer.alloc(524_289))
        })
        return oversized
      })
    await expect(ensureLatestOmaCli()).rejects.toThrow("output exceeded the limit")
    expect(oversized.kill).toHaveBeenCalledWith("SIGKILL")
  })
})
