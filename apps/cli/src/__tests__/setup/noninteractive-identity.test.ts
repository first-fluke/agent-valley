import { existsSync, readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setupNoninteractive } from "../../setup/noninteractive"
import { noninteractiveFixture } from "./noninteractive-fixture"

let fixture: ReturnType<typeof noninteractiveFixture>
beforeEach(() => {
  fixture = noninteractiveFixture()
})
afterEach(() => {
  fixture.cleanup()
})

describe("initiating agent Chief Director selection", () => {
  it("keeps an explicitly selected repository over a different saved workspace", async () => {
    fixture.write(fixture.projectPath, `workspace:\n  root: ${fixture.workspace}\nactor:\n  type: codex\n`)
    const result = await setupNoninteractive(
      { yes: true, workspace: fixture.deps.projectRoot, oma: "skip" },
      fixture.deps,
    )
    expect(result.workspace).toBe(fixture.deps.projectRoot)
    expect(fixture.json(fixture.projectPath).workspace.root).toBe(fixture.deps.projectRoot)
    expect(fixture.deps.prepareIntegrations).toHaveBeenCalledWith(fixture.deps.projectRoot, fixture.deps.projectRoot)
  })

  it("fails early with both missing key paths when no explicit/runtime/saved vendor exists", async () => {
    const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(result.error).toContain("actor.type")
    expect(result.error).toContain(fixture.projectPath)
    expect(result.error).toContain(fixture.globalConfigPath)
    expect(result.error).toContain("--actor <current-vendor>")
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
  })

  it.each(["CODEX_THREAD_ID", "CODEX_SESSION_ID"])(
    "selects Codex from %s instead of another saved Chief and clears the stale model",
    async (key) => {
      fixture.deps.env[key] = "opaque-session"
      fixture.write(fixture.globalConfigPath, "actor:\n  type: claude\n  model: old-opus\n")
      const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
      expect(result.chief).toMatchObject({
        actorType: "codex",
        actorSource: "runtime",
        model: null,
        modelSource: "runtime-native-default",
        runtimeIdentity: key,
      })
      expect(fixture.json(fixture.projectPath).actor).toEqual({ type: "codex" })
      expect(fixture.json(fixture.globalConfigPath).actor).toEqual({ type: "codex" })
    },
  )

  it.each(["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"])(
    "selects Claude from %s without inventing the active model",
    async (key) => {
      fixture.deps.env[key] = "1"
      fixture.deps.env.ANTHROPIC_MODEL = "configured-but-not-active-model"
      const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
      expect(result.chief).toMatchObject({
        actorType: "claude",
        actorSource: "runtime",
        model: null,
        modelSource: "runtime-native-default",
        runtimeIdentity: key,
      })
      expect(JSON.stringify(result)).not.toContain("configured-but-not-active-model")
    },
  )

  it("keeps the originating explicit vendor/model even when a different worker runtime performs setup", async () => {
    fixture.deps.env.CLAUDECODE = "1"
    fixture.deps.env.CODEX_THREAD_ID = "worker-session"
    const result = await setupNoninteractive(
      { yes: true, actor: "qwen", model: "initiator-model", oma: "skip" },
      fixture.deps,
    )
    expect(result.chief).toMatchObject({
      actorType: "qwen",
      actorSource: "explicit",
      model: "initiator-model",
      modelSource: "explicit",
    })
    expect(fixture.json(fixture.projectPath).actor).toEqual({ type: "qwen", model: "initiator-model" })
  })

  it("rejects ambiguous runtime markers rather than selecting a saved vendor", async () => {
    fixture.deps.env.CLAUDECODE = "1"
    fixture.deps.env.CODEX_THREAD_ID = "nested-session"
    fixture.write(fixture.globalConfigPath, "actor:\n  type: codex\n")
    const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(result.error).toContain("ambiguous")
    expect(existsSync(fixture.projectPath)).toBe(false)
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
  })

  it("clears a same-vendor stale pin when current runtime model is unknown", async () => {
    fixture.deps.env.CODEX_THREAD_ID = "session"
    fixture.write(fixture.globalConfigPath, "actor:\n  type: codex\n  model: stale-model\n")
    const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(result.chief.model).toBeNull()
    expect(fixture.json(fixture.globalConfigPath).actor.model).toBeUndefined()
  })

  it("honors explicit empty model clearing and otherwise preserves same-vendor saved pins", async () => {
    fixture.write(fixture.globalConfigPath, "actor:\n  type: codex\n  model: saved-model\n")
    const preserved = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
    expect(preserved.chief).toMatchObject({ model: "saved-model", modelSource: "global" })
    const cleared = await setupNoninteractive({ yes: true, actor: "codex", model: "", oma: "skip" }, fixture.deps)
    expect(cleared.chief).toMatchObject({ model: null, modelSource: "explicit-native-default" })
    expect(fixture.json(fixture.projectPath).actor.model).toBeUndefined()
    expect(fixture.json(fixture.globalConfigPath).actor.model).toBeUndefined()
  })

  it("uses valid legacy saved global defaults when runtime identity is not established", async () => {
    fixture.deps.env.OMA_DEFAULT_CLI = "claude"
    fixture.deps.env.CODEX_HOME = "/not-runtime-evidence"
    fixture.write(fixture.globalConfigPath, "agent:\n  type: cursor\n  model: saved-cursor\n")
    const result = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(result.chief).toMatchObject({
      actorType: "cursor",
      actorSource: "global",
      model: "saved-cursor",
      modelSource: "global",
      runtimeIdentity: null,
    })
    expect(fixture.json(fixture.globalConfigPath).agent).toBeUndefined()
  })

  it("rejects a stale custom provider command on vendor change without clobbering it", async () => {
    const original = "actor:\n  type: claude\n  command: custom-claude\n  timeout: 120\n"
    fixture.write(fixture.globalConfigPath, original)
    const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
    expect(result.error).toContain("actor.command")
    expect(readFileSync(fixture.globalConfigPath, "utf8")).toBe(original)
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
  })

  it("rejects reconfiguration inside an AV-managed Chief/Actor before any effects", async () => {
    fixture.deps.env.AGENT_VALLEY_MANAGED_RUN = "1"
    const result = await setupNoninteractive({ yes: true, actor: "codex" }, fixture.deps)
    expect(result.error).toContain("AV-managed")
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
  })
})
