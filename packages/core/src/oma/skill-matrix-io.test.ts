import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultSkillMatrixDeps } from "./skill-matrix-io"

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: execute,
}))
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "matrix-io-"))
  execute.mockReset()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("matrix local IO boundary", () => {
  it("reads bounded regular JSON and rejects symlinks, directories, oversized and invalid UTF-8 files", async () => {
    const path = join(directory, "report.json")
    await writeFile(path, '{"safe":true}')
    expect(await defaultSkillMatrixDeps.readReport(path)).toEqual({ safe: true })
    const link = join(directory, "link.json")
    await symlink(path, link)
    await expect(defaultSkillMatrixDeps.readReport(link)).rejects.toThrow()
    const folder = join(directory, "folder")
    await mkdir(folder)
    await expect(defaultSkillMatrixDeps.readReport(folder)).rejects.toThrow("regular file")
    await writeFile(path, " ".repeat(4 * 1_024 * 1_024 + 1))
    await expect(defaultSkillMatrixDeps.readReport(path)).rejects.toThrow("4 MiB")
    await writeFile(path, Buffer.from([0xff]))
    await expect(defaultSkillMatrixDeps.readReport(path)).rejects.toThrow()
  })

  it("runs only an installed injected plan and local CLI version, with bounded execution", async () => {
    execute.mockImplementation((_binary, _args, _options, callback) => callback(null, '{"mode":"plan"}'))
    expect(await defaultSkillMatrixDeps.plan("/target with spaces", ["oma-debug", "oma-qa"])).toEqual({ mode: "plan" })
    expect(execute).toHaveBeenCalledWith(
      "oma",
      [
        "skills",
        "matrix",
        "--project-root",
        "/target with spaces",
        "--skills",
        "oma-debug,oma-qa",
        "--delivery",
        "injected",
        "--vendors",
        "claude,codex",
        "--json",
      ],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4 * 1_024 * 1_024 }),
      expect.any(Function),
    )
    expect(execute.mock.calls[0]?.[1]).not.toContain("--live")
    execute.mockImplementation((_binary, _args, _options, callback) => callback(null, "  2.1.0 (Claude Code)\n"))
    expect(await defaultSkillMatrixDeps.cliVersion("claude")).toBe("2.1.0 (Claude Code)")
    expect(execute.mock.calls[1]?.[1]).toEqual(["--version"])
  })

  it("omits local command errors and stderr from failures", async () => {
    execute.mockImplementation((_binary, _args, _options, callback) =>
      callback(new Error("secret"), "", "SECRET_TOKEN"),
    )
    await expect(defaultSkillMatrixDeps.plan(directory, ["oma-debug"])).rejects.toThrow("local diagnostic")
    await expect(defaultSkillMatrixDeps.plan(directory, ["oma-debug"])).rejects.not.toThrow("secret")
  })
})
