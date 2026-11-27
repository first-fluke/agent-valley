import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildDarwinSandboxCommand, resetDarwinUserTempDirCache, resolveDarwinUserTempDir } from "./sandbox-darwin"

let directory: string
let protectedRoot: string
let alias: string
let workspace: string
let home: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "av-seatbelt-paths-")))
  protectedRoot = join(directory, "protected")
  alias = join(directory, "alias")
  workspace = join(directory, "workspace")
  home = join(directory, "home")
  for (const path of [protectedRoot, workspace, home]) mkdirSync(path)
  symlinkSync(protectedRoot, alias, "dir")
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function plan(workspacePath: string, args: string[] = []) {
  return buildDarwinSandboxCommand(
    { agentType: "claude", command: process.execPath, args, workspacePath, networkAllowlist: [] },
    "/usr/bin/sandbox-exec",
    home,
  )
}

describe("Darwin protected project path aliases", () => {
  it("includes alias and canonical denies even when the config file is not created yet", () => {
    vi.spyOn(process, "cwd").mockReturnValue(alias)
    const profile = plan(alias).args[1] as string
    for (const root of [alias, protectedRoot]) {
      const path = JSON.stringify(join(root, "av.yaml"))
      expect(profile).toContain(`(deny file-read* (literal ${path}))`)
      expect(profile).toContain(`(deny file-write* (literal ${path}))`)
    }
  })

  it.skipIf(process.platform !== "darwin").each(["workspace", "current cwd"])(
    "denies real OS config reads and writes through a symlinked %s while preserving product access",
    (location) => {
      const secret = "synthetic-project-config-only"
      const config = join(protectedRoot, "av.yaml")
      writeFileSync(config, secret)
      const target = location === "workspace" ? alias : workspace
      if (location === "current cwd") vi.spyOn(process, "cwd").mockReturnValue(alias)
      const run = (script: string, path: string) => {
        const command = plan(target, ["-e", script, path])
        const result = spawnSync(command.command, command.args, { cwd: target, encoding: "utf8", timeout: 5_000 })
        expect(result.error).toBeUndefined()
        expect(result.stderr).not.toContain(secret)
        return result
      }
      const product = run(
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'allowed');if(fs.readFileSync(process.argv[1],'utf8')!=='allowed')process.exit(2);",
        join(target, "product.txt"),
      )
      expect(product.status, product.stderr).toBe(0)
      for (const path of [join(alias, "av.yaml"), config]) {
        for (const operation of ["readFileSync(process.argv[1])", "writeFileSync(process.argv[1],'forbidden')"]) {
          const denied = run(
            `try{require('node:fs').${operation};process.exit(2)}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}`,
            path,
          )
          expect(denied.status, denied.stderr).toBe(0)
        }
      }
      expect(readFileSync(config, "utf8")).toBe(secret)
    },
  )
})

describe("Darwin temp directories (TMPDIR + DARWIN_USER_TEMP_DIR)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetDarwinUserTempDirCache()
  })

  it("allows file writes and local unix sockets for both req.env.TMPDIR and DARWIN_USER_TEMP_DIR with aliases", () => {
    const envTmpReal = join(directory, "env-tmp-real")
    const envTmpAlias = join(directory, "env-tmp-alias")
    const darwinTmpReal = join(directory, "darwin-tmp-real")
    const darwinTmpAlias = join(directory, "darwin-tmp-alias")
    for (const dir of [envTmpReal, darwinTmpReal]) mkdirSync(dir)
    symlinkSync(envTmpReal, envTmpAlias, "dir")
    symlinkSync(darwinTmpReal, darwinTmpAlias, "dir")
    vi.stubEnv("TMPDIR", "/tmp/oacp-override")

    const profile = buildDarwinSandboxCommand(
      {
        agentType: "claude",
        command: process.execPath,
        args: [],
        workspacePath: workspace,
        networkAllowlist: [],
        env: { TMPDIR: `${envTmpAlias}/` },
      },
      "/usr/bin/sandbox-exec",
      home,
      `${darwinTmpAlias}/`,
    ).args[1] as string

    for (const dir of [envTmpAlias, envTmpReal, darwinTmpAlias, darwinTmpReal, "/tmp/oacp-override"]) {
      const quoted = JSON.stringify(dir)
      expect(profile).toContain(`(allow file-write* (subpath ${quoted}))`)
      expect(profile).toContain(`(allow network-bind (local unix-socket (subpath ${quoted})))`)
      expect(profile).toContain(`(allow network-inbound (local unix-socket (subpath ${quoted})))`)
    }
    // Credential denies stay verbatim and after all allow rules.
    expect(profile.indexOf(`(allow file-write* (subpath ${JSON.stringify(darwinTmpReal)}))`)).toBeLessThan(
      profile.indexOf(`(deny file-write* (subpath ${JSON.stringify(`${home}/.config/agent-valley`)}))`),
    )
    expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(`${home}/.ssh`)}))`)
  })

  it("deduplicates overlapping temp directory write and unix socket rules", () => {
    vi.stubEnv("TMPDIR", "/tmp")
    const profile = buildDarwinSandboxCommand(
      {
        agentType: "claude",
        command: process.execPath,
        args: [],
        workspacePath: workspace,
        networkAllowlist: [],
        env: { TMPDIR: "/tmp/" },
      },
      "/usr/bin/sandbox-exec",
      home,
      "/tmp/",
    ).args[1] as string

    const writeTmpMatches = profile.match(/\(allow file-write\* \(subpath "\/tmp"\)\)/g) ?? []
    const bindTmpMatches = profile.match(/\(allow network-bind \(local unix-socket \(subpath "\/tmp"\)\)\)/g) ?? []
    expect(writeTmpMatches).toHaveLength(1)
    expect(bindTmpMatches).toHaveLength(1)
  })

  it("normalizes DARWIN_USER_TEMP_DIR and falls back cleanly off darwin or when getconf fails", () => {
    expect(resolveDarwinUserTempDir({ platform: "linux", read: () => "/var/folders/a/b/T/\n" })).toBeUndefined()
    expect(
      resolveDarwinUserTempDir({
        platform: "darwin",
        read: () => {
          throw new Error("ENOENT")
        },
      }),
    ).toBeUndefined()
    expect(resolveDarwinUserTempDir({ platform: "darwin", read: () => "relative/path/\n" })).toBeUndefined()
    expect(resolveDarwinUserTempDir({ platform: "darwin", read: () => "  /var/folders/ab/cd/T/  \n" })).toBe(
      "/var/folders/ab/cd/T",
    )
    expect(resolveDarwinUserTempDir({ platform: "darwin", read: () => "/" })).toBe("/")
  })
})
