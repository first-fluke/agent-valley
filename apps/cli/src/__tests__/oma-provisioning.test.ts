import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TerminalCommand } from "../agent-provisioning"
import { inspectOma, type OmaProvisioningDeps, prepareOma } from "../oma-provisioning"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-oma-provisioning-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function installFixture(names = ["oma-backend", "oma-explainer", "oma-video"]) {
  const skills = join(root, ".agents", "skills")
  await mkdir(skills, { recursive: true })
  await writeFile(
    join(skills, "_version.json"),
    JSON.stringify({
      schemaVersion: 2,
      version: "15.0.15",
      mode: "project",
      installedAt: "2026-10-03T00:00:00Z",
    }),
  )
  for (const name of names) {
    await mkdir(join(skills, name), { recursive: true })
    await writeFile(join(skills, name, "SKILL.md"), `# ${name}\nInstalled skill fixture.\n`)
  }
}

function deps(overrides: Partial<OmaProvisioningDeps> = {}): OmaProvisioningDeps {
  return {
    platform: "darwin",
    home: "/fixture/home",
    env: { HOME: "/fixture/home", PATH: "/fixture/bin" },
    resolveBinary: (name) => `/fixture/bin/${name}`,
    runCommand: vi.fn(async (request: TerminalCommand) => {
      if (request.args[0] === "x") await installFixture()
      return { success: true }
    }),
    makeTempDir: vi.fn(() => "/fixture/private-oma-installer"),
    removeTempDir: vi.fn(),
    ...overrides,
  }
}

describe("read-only OMA inspection", () => {
  it("reports missing project installation without spawning commands", async () => {
    const injected = deps()
    expect(await inspectOma(root, injected)).toMatchObject({ success: false })
    expect(injected.runCommand).not.toHaveBeenCalled()
  })

  it("reports project version and installed skills without requiring a temporary install lock", async () => {
    await installFixture()
    const injected = deps()
    expect(await inspectOma(root, injected)).toEqual({
      success: true,
      message: "OMA 15.0.15 is installed with 3 project skills. Prepare updates it to the latest full skill pack.",
    })
    expect(injected.runCommand).not.toHaveBeenCalled()
  })

  it.each([
    "not JSON",
    JSON.stringify({ schemaVersion: 1, version: "15.0.15", mode: "project" }),
    JSON.stringify({ schemaVersion: 2, version: "15.0.15", mode: "global" }),
    JSON.stringify({ schemaVersion: 2, version: "unverified", mode: "project" }),
  ])("does not claim verified readiness from invalid metadata: %s", async (metadata) => {
    await installFixture()
    await writeFile(join(root, ".agents", "skills", "_version.json"), metadata)
    expect((await inspectOma(root)).success).toBe(false)
  })

  it("rejects absent, incomplete, or externally linked skill catalogs", async () => {
    await installFixture([])
    expect((await inspectOma(root)).success).toBe(false)
    await mkdir(join(root, ".agents", "skills", "oma-missing"))
    expect((await inspectOma(root)).success).toBe(false)
    await rm(join(root, ".agents", "skills"), { recursive: true })
    await symlink(tmpdir(), join(root, ".agents", "skills"))
    expect((await inspectOma(root)).success).toBe(false)
  })
})

describe("trusted OMA preparation", () => {
  it("bootstraps prerequisites then awaits latest CLI installation and selected-workspace skill installation", async () => {
    const injected = deps({
      env: { HOME: "/fixture/home", PATH: "/fixture/bin", OMA_INSTALL_NO_RUN: "inherited-value" },
    })
    const result = await prepareOma(root, injected)
    expect(result.success).toBe(true)
    expect(result.message).toContain("Latest official OMA preparation completed")
    expect(result.message).toContain("3 project skills")
    const calls = vi.mocked(injected.runCommand).mock.calls.map(([command]) => command)
    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({ command: "/fixture/bin/curl", cwd: root, timeoutMs: 125_000 })
    expect(calls[0]?.args).toContain("--proto")
    expect(calls[0]?.args).toContain("--proto-redir")
    expect(calls[0]?.args).toContain("=https")
    expect(calls[0]?.args.at(-1)).toBe("https://raw.githubusercontent.com/first-fluke/oh-my-agent/main/cli/install.sh")
    expect(calls[1]).toMatchObject({
      command: "/fixture/bin/bash",
      args: ["/fixture/private-oma-installer/install.sh"],
      cwd: root,
    })
    expect(calls[1]?.env.OMA_INSTALL_NO_RUN).toBe("1")
    expect(calls[2]).toMatchObject({
      command: "/fixture/bin/bun",
      args: ["install", "--global", "oh-my-agent@latest"],
      cwd: root,
    })
    expect(calls[3]).toMatchObject({
      command: "/fixture/bin/bun",
      args: ["x", "--bun", "oh-my-agent@latest", "install"],
      cwd: root,
    })
    expect(calls[2]?.env.OMA_INSTALL_NO_RUN).toBeUndefined()
    expect(calls[3]?.env.OMA_INSTALL_NO_RUN).toBeUndefined()
    expect(calls[3]?.env.CI).toBe("true")
    expect(calls[3]?.env.OMA_YES).toBeUndefined()
    expect(calls.every((call) => call.cwd === root && call.timeoutMs <= 300_000)).toBe(true)
    expect(injected.removeTempDir).toHaveBeenCalledWith("/fixture/private-oma-installer")
    expect(injected.env.PATH?.startsWith("/fixture/home/.bun/bin")).toBe(true)
  })

  it("updates bundled or older subset installs with new full skills while preserving custom config and receipt mode", async () => {
    const agents = join(root, ".agents")
    await mkdir(join(agents, "skills", "oma-custom"), { recursive: true })
    await writeFile(join(agents, "skills", "oma-custom", "SKILL.md"), "# Custom skill\n")
    const configuration = "language: ko\nmodel_preset: custom\nagents:\n  backend:\n    model: user-selected\n"
    await writeFile(join(agents, "oma-config.yaml"), configuration)
    const av = "actor:\n  type: codex\noma:\n  mode: strict\n"
    await writeFile(join(root, "av.yaml"), av)
    const injected = deps()
    expect((await prepareOma(root, injected)).success).toBe(true)
    const command = vi.mocked(injected.runCommand).mock.calls.at(-1)?.[0]
    expect(command?.args).toEqual(["x", "--bun", "oh-my-agent@latest", "update", "--yes", "--with-new-skills", "--all"])
    expect(command?.args).not.toContain("--force")
    expect(await readFile(join(agents, "oma-config.yaml"), "utf8")).toBe(configuration)
    expect(await readFile(join(root, "av.yaml"), "utf8")).toBe(av)
    expect(await readFile(join(agents, "skills", "oma-explainer", "SKILL.md"), "utf8")).toContain("oma-explainer")
    expect((await inspectOma(root)).message).toContain("4 project skills")
  })

  it.each(["mcp.json", "workflows"])("recognizes existing legacy project installation from %s", async (marker) => {
    await mkdir(join(root, ".agents", "skills"), { recursive: true })
    if (marker === "workflows") await mkdir(join(root, ".agents", marker))
    else await writeFile(join(root, ".agents", marker), "{}\n")
    const injected = deps()
    expect((await prepareOma(root, injected)).success).toBe(true)
    expect(vi.mocked(injected.runCommand).mock.calls.at(-1)?.[0].args).toContain("update")
  })

  it("updates a modern version-marker-only installation without reinitializing it", async () => {
    await installFixture()
    const injected = deps()
    expect((await prepareOma(root, injected)).success).toBe(true)
    expect(vi.mocked(injected.runCommand).mock.calls.at(-1)?.[0].args).toEqual([
      "x",
      "--bun",
      "oh-my-agent@latest",
      "update",
      "--yes",
      "--with-new-skills",
      "--all",
    ])
  })

  it.each([
    ["oma-config.yaml", "oma-config.cue", false],
    ["oma-config.cue", "oma-config.yaml", false],
    ["oma-config.yaml", "oma-config.cue", true],
  ] as const)(
    "preserves effective %s configuration and removes newly generated %s defaults during prepare",
    async (original, alternate, installed) => {
      const agents = join(root, ".agents")
      await mkdir(agents)
      const path = join(agents, original)
      const content = original.endsWith("yaml")
        ? "language: ko\nmodel_preset: custom\n"
        : 'language: "ko"\nmodel_preset: "custom"\n'
      await writeFile(path, content, { mode: 0o600 })
      if (installed) await installFixture()
      const injected = deps({
        runCommand: vi.fn(async (request) => {
          if (request.args[0] === "x") {
            await writeFile(path, "Installer defaults\n")
            await chmod(path, 0o644)
            await writeFile(join(agents, alternate), "New format defaults\n")
            await installFixture()
          }
          return { success: true }
        }),
      })
      expect((await prepareOma(root, injected)).success).toBe(true)
      expect(await readFile(path, "utf8")).toBe(content)
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
      await expect(readFile(join(agents, alternate))).rejects.toMatchObject({ code: "ENOENT" })
      expect(vi.mocked(injected.runCommand).mock.calls.at(-1)?.[0].args).toContain(installed ? "update" : "install")
    },
  )

  it("preserves both existing configuration formats and restores them after an interrupted native installer", async () => {
    const agents = join(root, ".agents")
    await mkdir(agents)
    for (const name of ["oma-config.yaml", "oma-config.cue", "mcp.json"])
      await writeFile(join(agents, name), `Custom ${name}\n`)
    const injected = deps({
      runCommand: vi.fn(async (request) => {
        if (request.args[0] === "x") {
          for (const name of ["oma-config.yaml", "oma-config.cue", "mcp.json"])
            await writeFile(join(agents, name), "Replacement\n")
          throw new Error("Interrupted installation")
        }
        return { success: true }
      }),
    })
    expect((await prepareOma(root, injected)).success).toBe(false)
    for (const name of ["oma-config.yaml", "oma-config.cue", "mcp.json"])
      expect(await readFile(join(agents, name), "utf8")).toBe(`Custom ${name}\n`)
  })

  it.each([0, 1, 2, 3])("stops after failure in native stage %s with retry guidance", async (failureIndex) => {
    let index = 0
    const injected = deps({
      runCommand: vi.fn(async () =>
        index++ === failureIndex ? { success: false, failure: "timed_out" as const } : { success: true },
      ),
    })
    const result = await prepareOma(root, injected)
    expect(result.success).toBe(false)
    expect(result.message).toContain("timed out")
    expect(result.message).toContain("Retry")
    expect(injected.runCommand).toHaveBeenCalledTimes(failureIndex + 1)
    expect(injected.removeTempDir).toHaveBeenCalledOnce()
  })

  it("does not trust command success without verified installed project files", async () => {
    const injected = deps({ runCommand: vi.fn(async () => ({ success: true })) })
    const result = await prepareOma(root, injected)
    expect(result.success).toBe(false)
    expect(result.message).toContain("could not be verified")
    expect(result.message).toContain("Retry")
  })

  it("reports missing prerequisites and rejects unsupported or invalid targets before installers run", async () => {
    const missing = deps({ resolveBinary: () => null })
    expect((await prepareOma(root, missing)).message).toContain("curl and bash")
    expect(missing.runCommand).not.toHaveBeenCalled()
    const windows = deps({ platform: "win32" })
    expect((await prepareOma(root, windows)).message).toContain("WSL")
    expect(windows.runCommand).not.toHaveBeenCalled()
    const invalid = deps()
    expect((await prepareOma("relative-workspace", invalid)).success).toBe(false)
    expect((await prepareOma(join(root, "missing"), invalid)).success).toBe(false)
    expect(invalid.runCommand).not.toHaveBeenCalled()
  })

  it("reports a failed bootstrap that never makes Bun available", async () => {
    const injected = deps({ resolveBinary: (name) => (name === "bun" ? null : `/fixture/bin/${name}`) })
    expect((await prepareOma(root, injected)).message).toContain("Bun was not found")
    expect(injected.runCommand).toHaveBeenCalledTimes(2)
  })

  it("redacts native exceptions and removes private temporary files", async () => {
    const secret = "synthetic-secret-not-for-messages"
    const injected = deps({
      runCommand: vi.fn(async () => {
        throw new Error(secret)
      }),
    })
    const result = await prepareOma(root, injected)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.message).toContain("Retry")
    expect(injected.removeTempDir).toHaveBeenCalledOnce()
  })
})
