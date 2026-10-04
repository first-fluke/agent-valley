import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyIntegrationFiles, integrationFile } from "../../client-integrations-files"
import { setupNoninteractive } from "../../setup/noninteractive"
import { noninteractiveFixture } from "./noninteractive-fixture"

let fixture: ReturnType<typeof noninteractiveFixture>
beforeEach(() => {
  fixture = noninteractiveFixture()
})
afterEach(() => {
  fixture.cleanup()
})

describe("headless setup transaction", () => {
  it("reports and atomically applies a mode-only change while preserving bytes", async () => {
    const path = join(fixture.root, "mode-only.yaml")
    const content = "actor:\n  type: codex\n"
    await writeFile(path, content, { mode: 0o644 })
    const file = await integrationFile(fixture.root, path, content)
    file.writeMode = 0o600
    expect(await applyIntegrationFiles(fixture.root, [file])).toEqual([path])
    expect(await readFile(path, "utf8")).toBe(content)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const repeat = await integrationFile(fixture.root, path, content)
    repeat.writeMode = 0o600
    expect(await applyIntegrationFiles(fixture.root, [repeat])).toEqual([])
  })

  it("rolls back changed AV config bytes and mode when a later snapshot changed concurrently", async () => {
    const project = `workspace:\n  root: ${fixture.workspace}\nactor:\n  type: claude\n`
    const global = "actor:\n  type: claude\n"
    fixture.write(fixture.projectPath, project)
    fixture.write(fixture.globalConfigPath, global)
    await chmod(fixture.projectPath, 0o644)
    fixture.deps.applyFiles.mockImplementation(async (root, files) => {
      await writeFile(fixture.globalConfigPath, "actor:\n  type: claude\nserver:\n  port: 9001\n")
      return applyIntegrationFiles(root, files)
    })
    const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
    expect(result).toMatchObject({ status: "failed", exitCode: 1, config: { saved: false } })
    expect(result.error).toContain("changed during installation")
    expect(await readFile(fixture.projectPath, "utf8")).toBe(project)
    expect((await stat(fixture.projectPath)).mode & 0o777).toBe(0o644)
    expect(await readFile(fixture.globalConfigPath, "utf8")).toContain("port: 9001")
  })

  it("restores the original mode after a mode-only save is followed by a later conflict", async () => {
    const first = join(fixture.root, "first.yaml")
    const second = join(fixture.root, "second.yaml")
    await writeFile(first, "unchanged content\n", { mode: 0o644 })
    await writeFile(second, "original\n")
    const modeOnly = await integrationFile(fixture.root, first, "unchanged content\n")
    modeOnly.writeMode = 0o600
    const other = await integrationFile(fixture.root, second, "planned\n")
    await writeFile(second, "concurrent edit\n")
    await expect(applyIntegrationFiles(fixture.root, [modeOnly, other])).rejects.toThrow("changed during installation")
    expect(await readFile(first, "utf8")).toBe("unchanged content\n")
    expect((await stat(first)).mode & 0o777).toBe(0o644)
    expect(await readFile(second, "utf8")).toBe("concurrent edit\n")
  })

  it("retains an unowned AV skill and refuses all mutations before provisioning", async () => {
    const path = join(fixture.workspace, ".agents/skills/av/SKILL.md")
    fixture.write(path, "unowned AV instructions\n")
    const result = await setupNoninteractive({ yes: true, actor: "codex", workspace: fixture.workspace }, fixture.deps)
    expect(result.error).toContain("unowned")
    expect(await readFile(path, "utf8")).toBe("unowned AV instructions\n")
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
    expect(fixture.deps.applyFiles).not.toHaveBeenCalled()
  })

  it("preserves another MCP entry and its file mode while applying the AV entry", async () => {
    const path = join(fixture.workspace, ".mcp.json")
    fixture.write(
      path,
      JSON.stringify({ mcpServers: { other: { command: "other", env: { API_KEY: "fixture-secret" } } } }),
    )
    await chmod(path, 0o640)
    const result = await setupNoninteractive(
      { yes: true, actor: "codex", workspace: fixture.workspace, oma: "skip" },
      fixture.deps,
    )
    expect(result.status).toBe("ready")
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.other.env.API_KEY).toBe("fixture-secret")
    expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
  })
})
