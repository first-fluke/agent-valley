import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamConfigMigrationError } from "@agent-valley/core/config/team-schema"
import { afterEach, beforeEach, expect, it } from "vitest"
import { defaultDoctorDeps } from "../../doctor-checks"
import { checkConfig, computeExitCode } from "../../doctor-config-checks"
import { readSetupGlobalConfig } from "../../setup/global-settings"
import { setupNoninteractive } from "../../setup/noninteractive"
import { noninteractiveFixture } from "./noninteractive-fixture"

let directory: string
let originalXdg: string | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "av-team-migration-"))
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = directory
  mkdirSync(join(directory, "agent-valley"))
})
afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  rmSync(directory, { recursive: true, force: true })
})

it("preserves retired settings instead of silently deleting authentication keys during setup repair", () => {
  const path = join(directory, "agent-valley", "settings.yaml")
  const original = "team:\n  supabase_anon_key: RETIRED_TEST_VALUE\n"
  writeFileSync(path, original)
  expect(readSetupGlobalConfig).toThrow(TeamConfigMigrationError)
  expect(readSetupGlobalConfig).toThrow("team.relay_url")
  expect(readFileSync(path, "utf8")).toBe(original)
})

it("doctor reports the exact migration key and config file without exposing its value", () => {
  const path = join(directory, "agent-valley", "settings.yaml")
  writeFileSync(path, "team:\n  supabase_url: RETIRED_TEST_VALUE\n")
  const { results } = checkConfig({ ...defaultDoctorDeps(), cwd: directory })
  const result = results.find((check) => check.id === "config.global")
  expect(result?.status).toBe("fail")
  expect(result?.message).toContain(path)
  expect(result?.message).toContain("team.supabase_url")
  expect(result?.message).toContain("team.relay_url")
  expect(JSON.stringify(results)).not.toContain("RETIRED_TEST_VALUE")
  expect(computeExitCode(results)).toBe(1)
})

it.each(["project", "global"] as const)(
  "headless setup preserves legacy %s config and reports the new keys",
  async (scope) => {
    const fixture = noninteractiveFixture()
    const path = scope === "project" ? fixture.projectPath : fixture.globalConfigPath
    const content = "team:\n  supabase_anon_key: RETIRED_TEST_VALUE\n"
    try {
      fixture.write(path, content)
      const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
      expect(result).toMatchObject({ status: "failed", exitCode: 1, config: { saved: false } })
      expect(result.error).toContain(path)
      expect(result.error).toContain("team.supabase_anon_key")
      expect(result.error).toContain("team.relay_url")
      expect(result.error).not.toContain("RETIRED_TEST_VALUE")
      expect(fixture.deps.applyFiles).not.toHaveBeenCalled()
      expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
      expect(readFileSync(path, "utf8")).toBe(content)
    } finally {
      fixture.cleanup()
    }
  },
)
