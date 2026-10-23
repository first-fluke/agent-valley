import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"

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
