import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const cli = resolve(import.meta.dirname, "../index.ts")

describe("setup command options", () => {
  it("advertises order and tracker setup without starting the wizard", async () => {
    const { stdout } = await exec("bun", [cli, "setup", "--help"], { timeout: 10_000 })
    expect(stdout).toContain("--mode <mode>")
    expect(stdout).toContain('choices: "order", "tracker"')
  })

  it("rejects unknown modes before any interactive setup", async () => {
    await expect(exec("bun", [cli, "setup", "--mode", "missing"], { timeout: 10_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Allowed choices are order, tracker"),
    })
  })

  it("keeps partial editing separate from mode selection", async () => {
    await expect(exec("bun", [cli, "setup", "--edit", "--mode", "order"], { timeout: 10_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("cannot be used with option '--edit'"),
    })
  })
})
