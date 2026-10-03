import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"
import { buildLinuxSandboxCommand } from "./sandbox-linux"

const request = { agentType: "codex", command: "codex", args: [], networkAllowlist: [] }

describe("project config protection", () => {
  it("denies av.yaml in the project and actor workspace on Darwin", () => {
    const workspacePath = "/workspaces/config-protection"
    const profile = buildDarwinSandboxCommand({ ...request, workspacePath }).args[1] as string
    for (const root of [process.cwd(), workspacePath]) {
      expect(profile).toContain(`(deny file-read* (literal "${join(root, "av.yaml")}"))`)
      expect(profile).toContain(`(deny file-write* (literal "${join(root, "av.yaml")}"))`)
      expect(profile).not.toContain(join(root, "valley.yaml"))
    }
  })

  it("masks av.yaml after writable workspace binds on Linux", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "av-sandbox-config-"))
    try {
      const args = buildLinuxSandboxCommand({ ...request, workspacePath }).args
      const workspaceBind = args.findIndex((arg, index) => arg === "--bind-try" && args[index + 1] === workspacePath)
      const mask = args.findIndex(
        (arg, index) =>
          arg === "--ro-bind" && args[index + 1] === "/dev/null" && args[index + 2] === join(workspacePath, "av.yaml"),
      )
      expect(mask).toBeGreaterThan(workspaceBind)
      expect(args).not.toContain(join(workspacePath, "valley.yaml"))
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it("keeps av.yaml masked even when the workspace is outside the mounted home", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "av-sandbox-workspace-"))
    const fakeHome = mkdtempSync(join(process.cwd(), ".sandbox-config-home-"))
    try {
      const args = buildLinuxSandboxCommand({ ...request, workspacePath }, "bwrap", fakeHome).args
      expect(args).toContain(join(workspacePath, "av.yaml"))
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("protects config files in a project root exposed through the temporary-directory bind", () => {
    const root = mkdtempSync(join(tmpdir(), "av-sandbox-project-"))
    const workspacePath = mkdtempSync(join(tmpdir(), "av-sandbox-actor-"))
    const fakeHome = mkdtempSync(join(tmpdir(), "av-sandbox-home-"))
    const originalRoot = process.cwd()
    try {
      process.chdir(root)
      const projectRoot = process.cwd()
      const args = buildLinuxSandboxCommand({ ...request, workspacePath }, "bwrap", fakeHome).args
      expect(args).toContain(join(projectRoot, "av.yaml"))
      expect(args).toContain(join(workspacePath, "av.yaml"))
    } finally {
      process.chdir(originalRoot)
      for (const path of [root, workspacePath, fakeHome]) rmSync(path, { recursive: true, force: true })
    }
  })
})
