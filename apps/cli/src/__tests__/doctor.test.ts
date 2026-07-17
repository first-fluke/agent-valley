/**
 * doctor.test.ts — Presentation-layer tests for `av doctor`: report
 * formatting (icons, fix lines, summary, exit code) and commander
 * wiring. `doctor-checks` is module-mocked so these tests exercise only
 * doctor.ts's own printing/exit-code/registration logic, never the real
 * filesystem, PATH, or a real agent CLI.
 */

import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../doctor-checks", () => ({
  AGENT_TYPES: ["claude", "codex", "antigravity", "cursor", "grok", "kimi", "opencode"],
  defaultDoctorDeps: vi.fn(() => ({ marker: "default-deps" })),
}))

vi.mock("../doctor-config-checks", () => ({
  runDoctorChecks: vi.fn(),
  computeExitCode: vi.fn(),
  summarize: vi.fn(),
}))

// Import AFTER mocks are registered
import { doctor, registerDoctorCommand } from "../doctor"
import { defaultDoctorDeps } from "../doctor-checks"
import { computeExitCode, runDoctorChecks, summarize } from "../doctor-config-checks"

const runDoctorChecksMock = vi.mocked(runDoctorChecks)
const computeExitCodeMock = vi.mocked(computeExitCode)
const summarizeMock = vi.mocked(summarize)
const defaultDoctorDepsMock = vi.mocked(defaultDoctorDeps)

const fakeDeps = { marker: "fake-deps" } as unknown as ReturnType<typeof defaultDoctorDeps>

beforeEach(() => {
  vi.clearAllMocks()
  runDoctorChecksMock.mockResolvedValue([])
  computeExitCodeMock.mockReturnValue(0)
  summarizeMock.mockReturnValue({ passed: 0, total: 0 })
  defaultDoctorDepsMock.mockReturnValue({ marker: "default-deps" } as unknown as ReturnType<typeof defaultDoctorDeps>)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("doctor()", () => {
  it("passes deps + allAgents option through to runDoctorChecks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    await doctor({ all: true }, fakeDeps)
    expect(runDoctorChecksMock).toHaveBeenCalledWith(fakeDeps, { allAgents: true })
  })

  it("uses defaultDoctorDeps() when no deps argument is given", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    await doctor({})
    expect(defaultDoctorDepsMock).toHaveBeenCalled()
    expect(runDoctorChecksMock).toHaveBeenCalledWith({ marker: "default-deps" }, { allAgents: undefined })
  })

  it("prints an icon + name + message line per result, and a Fix line only for non-pass results", async () => {
    runDoctorChecksMock.mockResolvedValue([
      { id: "a", name: "Config A", status: "pass", message: "all good", critical: false },
      {
        id: "b",
        name: "Sandbox B",
        status: "fail",
        message: "missing binary",
        fix: "install the thing",
        critical: true,
      },
      { id: "c", name: "Tunnel C", status: "warn", message: "no authtoken", fix: "run ngrok config", critical: false },
    ])
    computeExitCodeMock.mockReturnValue(1)
    summarizeMock.mockReturnValue({ passed: 1, total: 3 })

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const exitCode = await doctor({}, fakeDeps)

    const lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("Config A") && l.includes("all good"))).toBe(true)
    expect(lines.some((l) => l.includes("Sandbox B") && l.includes("missing binary"))).toBe(true)
    expect(lines.some((l) => l.includes("Fix:") && l.includes("install the thing"))).toBe(true)
    expect(lines.some((l) => l.includes("Fix:") && l.includes("run ngrok config"))).toBe(true)
    // The passing result must not get a Fix line (banner text below also
    // mentions "Fix:" generically, so match only the indented fix lines).
    expect(lines.filter((l) => l.trim().startsWith("Fix:"))).toHaveLength(2)
    expect(lines.some((l) => l.includes("1/3 checks passed"))).toBe(true)
    expect(exitCode).toBe(1)
  })

  it("prints a critical-failure banner only when the exit code is non-zero", async () => {
    computeExitCodeMock.mockReturnValue(0)
    let logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await doctor({}, fakeDeps)
    let lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("Critical checks failed"))).toBe(false)
    logSpy.mockRestore()

    computeExitCodeMock.mockReturnValue(1)
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await doctor({}, fakeDeps)
    lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("Critical checks failed"))).toBe(true)
  })
})

describe("registerDoctorCommand", () => {
  it("registers a `doctor` command with a description and an --all option", () => {
    const program = new Command()
    registerDoctorCommand(program)

    const cmd = program.commands.find((c) => c.name() === "doctor")
    expect(cmd).toBeDefined()
    expect(cmd?.description()).toContain("Diagnose")
    expect(cmd?.options.some((o) => o.long === "--all")).toBe(true)
  })

  it("action handler calls doctor({all}) and exits with the computed exit code", async () => {
    computeExitCodeMock.mockReturnValue(1)
    vi.spyOn(console, "log").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    const program = new Command()
    registerDoctorCommand(program)
    await program.parseAsync(["doctor", "--all"], { from: "user" })

    expect(runDoctorChecksMock).toHaveBeenCalledWith({ marker: "default-deps" }, { allAgents: true })
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("action handler exits 0 when all critical checks pass", async () => {
    computeExitCodeMock.mockReturnValue(0)
    vi.spyOn(console, "log").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    const program = new Command()
    registerDoctorCommand(program)
    await program.parseAsync(["doctor"], { from: "user" })

    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
