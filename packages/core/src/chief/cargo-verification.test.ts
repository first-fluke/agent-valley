import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeSymlink as symlink } from "../__tests__/test-platform"
import { fixture } from "./goal-supervision.fixture"
import { planPrompt } from "./prompts"
import { executeGoalVerification, safeVerificationCommand, validateGoalVerificationContract } from "./verification"

const directories: string[] = []
const commands = [
  ["fmt", "--all", "--", "--check"],
  ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
  ["test", "--workspace"],
]
const criterion = "Rust workspace quality gates pass"
const contract = {
  version: 1,
  criteria: [{ criterion, checks: commands.map((args) => ({ kind: "command", program: "cargo", args })) }],
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-cargo-verification-"))
  directories.push(root)
  await mkdir(join(root, "crates/storage/src"), { recursive: true })
  await mkdir(join(root, ".cargo"))
  await writeFile(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/storage"]\n')
  await writeFile(join(root, "Cargo.lock"), "version = 4\n")
  await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
  await writeFile(join(root, ".cargo/config.toml"), "[net]\noffline = true\n")
  await writeFile(join(root, "crates/storage/Cargo.toml"), '[package]\nname = "storage"\nversion = "0.1.0"\n')
  await writeFile(join(root, "crates/storage/src/lib.rs"), "pub fn healthy() -> bool { true }\n")
  return root
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("generated native Cargo verification", () => {
  it("accepts only the three exact native workspace quality gates", () => {
    for (const args of commands) expect(safeVerificationCommand("cargo", args)).toBe(true)
    expect(validateGoalVerificationContract(contract, [criterion]).criteria[0]?.checks).toHaveLength(3)
    for (const args of [
      ["build"],
      ["install", "cargo-hack"],
      ["publish"],
      ["run"],
      ["exec", "sh"],
      ["custom-alias"],
      ["--config", "alias.test=run", "test", "--workspace"],
      ["test", "--workspace", "--manifest-path", "../Cargo.toml"],
      ["test", "--workspace", "--config=build.rustc-wrapper=sh"],
      ["+nightly", "test", "--workspace"],
      ["fmt", "--all"],
      ["test", "--workspace", "--", "--ignored"],
      ["test", "--workspace\n"],
    ])
      expect(safeVerificationCommand("cargo", args)).toBe(false)
  })

  it("records fixed Cargo argv, process output and real workspace input hashes without running Cargo", async () => {
    const root = await workspace()
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "quality gates passed", stderr: "" }))
    const result = await executeGoalVerification(contract, root, { successCriteria: [criterion], executeCommand })
    expect(result.ok).toBe(true)
    expect(executeCommand.mock.calls.map((call) => call.slice(0, 2))).toEqual(commands.map((args) => ["cargo", args]))
    for (const check of result.evidence[0]?.checks ?? []) {
      expect(check.inputs?.map((input) => input.path)).toEqual([
        ".cargo/config.toml",
        "Cargo.lock",
        "Cargo.toml",
        "crates/storage/Cargo.toml",
        "crates/storage/src/lib.rs",
        "rust-toolchain.toml",
      ])
      expect(check.inputs?.every((input) => /^[a-f0-9]{64}$/.test(input.sha256))).toBe(true)
    }
    executeCommand.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "failed quality gate" })
    expect((await executeGoalVerification(contract, root, { successCriteria: [criterion], executeCommand })).ok).toBe(
      false,
    )
  })

  it("rejects source and lockfile drift during the native check", async () => {
    for (const name of ["Cargo.lock", "crates/storage/src/lib.rs"]) {
      const root = await workspace()
      const result = await executeGoalVerification(contract, root, {
        successCriteria: [criterion],
        executeCommand: async () => {
          await writeFile(join(root, name), "changed during verification")
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      })
      expect(result.ok).toBe(false)
      expect(result.output).toContain("inputs changed")
    }
  })

  it("excludes compiler output while requiring an actual manifest and contained source inputs", async () => {
    const root = await workspace()
    await mkdir(join(root, "target/debug"), { recursive: true })
    await mkdir(join(root, ".claude"))
    await symlink(join(root, "crates"), join(root, ".claude/skills"))
    const result = await executeGoalVerification(contract, root, {
      successCriteria: [criterion],
      executeCommand: async () => {
        await writeFile(join(root, "target/debug/generated.rs"), "compiler output")
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(result.ok).toBe(true)
    const executeCommand = vi.fn()
    await rm(join(root, "Cargo.toml"))
    expect(
      (await executeGoalVerification(contract, root, { successCriteria: [criterion], executeCommand })).output,
    ).toContain("Cargo.toml")
    expect(executeCommand).not.toHaveBeenCalled()
    await writeFile(join(root, "Cargo.toml"), "[workspace]")
    await symlink(join(root, "Cargo.lock"), join(root, "linked.rs"))
    expect(
      (await executeGoalVerification(contract, root, { successCriteria: [criterion], executeCommand })).output,
    ).toContain("symlink")
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it("gives the planner exact Rust check shapes without requiring harness-source discovery", () => {
    const mission = fixture().mission
    mission.verificationMode = "chief"
    const prompt = planPrompt(mission)
    for (const args of commands) expect(prompt).toContain(JSON.stringify(args))
    expect(prompt).toContain('"program":"cargo"')
    expect(prompt).toContain("no harness validator-source discovery is needed")
    expect(prompt).toContain("Cargo verification runs offline")
  })
})
