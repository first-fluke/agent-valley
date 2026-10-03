import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveProjectConfigPath } from "./project-config-path"
import { loadProjectConfig } from "./yaml-loader"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "av-project-config-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("av.yaml project configuration", () => {
  it("resolves av.yaml when the configuration file is absent", () => {
    expect(resolveProjectConfigPath(root)).toBe(join(root, "av.yaml"))
    expect(loadProjectConfig(root)).toBeNull()
  })

  it("ignores valley.yaml when av.yaml is absent", () => {
    writeFileSync(join(root, "valley.yaml"), "agent:\n  type: codex\n")
    expect(resolveProjectConfigPath(root)).toBe(join(root, "av.yaml"))
    expect(loadProjectConfig(root)).toBeNull()
  })

  it("reads av.yaml without using fields from an unrelated valley.yaml file", () => {
    writeFileSync(join(root, "av.yaml"), "actor:\n  type: kimi\n")
    writeFileSync(join(root, "valley.yaml"), "agent:\n  type: codex\nworkspace:\n  root: /legacy-only\n")
    expect(resolveProjectConfigPath(root)).toBe(join(root, "av.yaml"))
    expect(loadProjectConfig(root)).toMatchObject({ actor: { type: "kimi" }, agent: { type: "kimi" } })
    expect(loadProjectConfig(root)?.workspace).toBeUndefined()
  })

  it.each(["actor:\n  type: unavailable\n", "actor: [\n"])("reports invalid av.yaml configuration: %s", (canonical) => {
    writeFileSync(join(root, "av.yaml"), canonical)
    writeFileSync(join(root, "valley.yaml"), "agent:\n  type: codex\n")
    expect(() => loadProjectConfig(root)).toThrow(join(root, "av.yaml"))
  })

  it("ignores unrelated configuration when av.yaml is empty", () => {
    writeFileSync(join(root, "av.yaml"), "")
    writeFileSync(join(root, "valley.yaml"), "agent:\n  type: codex\n")
    expect(loadProjectConfig(root)).toBeNull()
  })

  it("does not read other files when av.yaml is a directory or broken symlink", () => {
    writeFileSync(join(root, "valley.yaml"), "agent:\n  type: codex\n")
    mkdirSync(join(root, "av.yaml"))
    expect(resolveProjectConfigPath(root)).toBe(join(root, "av.yaml"))
    expect(() => loadProjectConfig(root)).toThrow(join(root, "av.yaml"))
    rmSync(join(root, "av.yaml"), { recursive: true })
    symlinkSync(join(root, "missing.yaml"), join(root, "av.yaml"))
    expect(resolveProjectConfigPath(root)).toBe(join(root, "av.yaml"))
    expect(loadProjectConfig(root)).toBeNull()
  })
})
