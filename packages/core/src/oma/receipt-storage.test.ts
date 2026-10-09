import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { listOmaRunFiles, omaReceiptDirectories, resolveOmaReceiptPath } from "./receipt-storage"

const RUN_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const
const roots: string[] = []

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-oma-storage-")))
  roots.push(root)
  const workspace = join(root, "workspace")
  const home = join(root, "home")
  const stateHome = join(root, "state")
  mkdirSync(workspace)
  mkdirSync(home)
  return { root, workspace, home, stateHome }
}

function projectKey(workspace: string): string {
  return createHash("sha256").update(realpathSync(workspace)).digest("hex")
}

function centralDirectory(workspace: string, stateHome: string, profile = "0"): string {
  return join(stateHome, "u", profile, "projects", projectKey(workspace), "agent-runs")
}

function legacyDirectory(workspace: string): string {
  return join(workspace, ".agents", "state", "agent-runs")
}

function writeRun(directory: string, runId: string = RUN_IDS[0]): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${runId}.json`)
  writeFileSync(path, JSON.stringify({ runId }))
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("OMA receipt storage", () => {
  test("uses the selected state home and defaults to profile zero", () => {
    const { workspace, home, stateHome } = fixture()
    const legacy = legacyDirectory(workspace)
    expect(omaReceiptDirectories(workspace, { home, env: {} })).toEqual([
      centralDirectory(workspace, join(home, ".oma")),
      legacy,
    ])
    expect(omaReceiptDirectories(workspace, { home, env: { OMA_HOME: "" } })).toEqual([
      centralDirectory(workspace, join(home, ".oma")),
      legacy,
    ])
    expect(omaReceiptDirectories(workspace, { home, env: { OMA_HOME: stateHome } })).toEqual([
      centralDirectory(workspace, stateHome),
      legacy,
    ])
    expect(
      omaReceiptDirectories(workspace, { home, env: { OMA_STATE_HOME: stateHome, OMA_HOME: "relative-unused-home" } }),
    ).toEqual([centralDirectory(workspace, stateHome), legacy])
  })

  test.each([
    { OMA_STATE_HOME: "" },
    { OMA_STATE_HOME: "relative" },
    { OMA_STATE_HOME: "/tmp/invalid\nstate" },
    { OMA_HOME: "relative" },
    { OMA_HOME: "/tmp/invalid\u0000home" },
  ])("rejects invalid selected state-home configuration %j", (env) => {
    const { workspace, home, stateHome } = fixture()
    expect(() => omaReceiptDirectories(workspace, { home, env: { OMA_HOME: stateHome, ...env } })).toThrow(
      env.OMA_STATE_HOME === undefined ? "OMA_HOME" : "OMA_STATE_HOME",
    )
  })

  test.each(["", "01", "-1", "../0", "1/2", "1.0", "10000000000"])("rejects invalid profile %j", (profile) => {
    const { workspace, home } = fixture()
    expect(() => omaReceiptDirectories(workspace, { home, env: { OMA_PROFILE: profile } })).toThrow("OMA_PROFILE")
  })

  test.each(["1", "9999999999"])("restricts nonzero profile %s to its central directory", (profile) => {
    const { workspace, stateHome } = fixture()
    const options = { env: { OMA_STATE_HOME: stateHome, OMA_PROFILE: profile } }
    const central = centralDirectory(workspace, stateHome, profile)
    const selected = writeRun(central)
    const legacy = writeRun(legacyDirectory(workspace), RUN_IDS[1])
    writeRun(centralDirectory(workspace, stateHome), RUN_IDS[2])
    expect(omaReceiptDirectories(workspace, options)).toEqual([central])
    expect(listOmaRunFiles(workspace, options)).toEqual([selected])
    expect(() => resolveOmaReceiptPath(workspace, legacy, options)).toThrow("outside the selected project/profile")
  })

  test("hashes the canonical workspace when the caller uses a directory alias", () => {
    const { root, workspace, stateHome } = fixture()
    const alias = join(root, "workspace-alias")
    symlinkSync(workspace, alias, "dir")
    const options = { env: { OMA_STATE_HOME: stateHome } }
    const central = centralDirectory(workspace, stateHome)
    const selected = writeRun(central)
    expect(omaReceiptDirectories(alias, options)).toEqual([central, legacyDirectory(alias)])
    expect(listOmaRunFiles(alias, options)).toEqual([selected])
  })

  test("lists only UUID JSON files from the selected project, profile, and home plus legacy storage", () => {
    const { root, workspace, stateHome } = fixture()
    const otherWorkspace = join(root, "other-workspace")
    const otherHome = join(root, "other-home")
    mkdirSync(otherWorkspace)
    const options = { env: { OMA_STATE_HOME: stateHome, OMA_HOME: otherHome } }
    const central = centralDirectory(workspace, stateHome)
    const selected = writeRun(central)
    const legacy = writeRun(legacyDirectory(workspace), RUN_IDS[1])
    writeRun(centralDirectory(otherWorkspace, stateHome), RUN_IDS[2])
    writeRun(centralDirectory(workspace, stateHome, "1"), RUN_IDS[3])
    writeRun(centralDirectory(workspace, otherHome), RUN_IDS[4])
    writeFileSync(join(central, "not-a-run.json"), "{}")
    writeFileSync(join(central, `${RUN_IDS[0]}.json.bak`), "{}")
    expect(listOmaRunFiles(workspace, options).sort()).toEqual([selected, legacy].sort())
    expect(resolveOmaReceiptPath(workspace, selected, options)).toBe(selected)
    expect(resolveOmaReceiptPath(workspace, legacy, options)).toBe(legacy)
    expect(resolveOmaReceiptPath(workspace, `${RUN_IDS[1]}.json`, options)).toBe(legacy)
  })

  test("treats missing storage directories as empty", () => {
    const { workspace, stateHome } = fixture()
    const options = { env: { OMA_STATE_HOME: stateHome } }
    expect(listOmaRunFiles(workspace, options)).toEqual([])
    const legacy = writeRun(legacyDirectory(workspace))
    expect(listOmaRunFiles(workspace, options)).toEqual([legacy])
    rmSync(legacyDirectory(workspace), { recursive: true })
    const central = writeRun(centralDirectory(workspace, stateHome))
    expect(listOmaRunFiles(workspace, options)).toEqual([central])
  })

  test("rejects foreign, relative, and noncanonical receipt paths", () => {
    const { root, workspace, stateHome } = fixture()
    const options = { env: { OMA_STATE_HOME: stateHome } }
    const central = centralDirectory(workspace, stateHome)
    writeRun(central)
    const filename = `${RUN_IDS[0]}.json`
    const candidates = [
      join(root, "foreign", filename),
      join(centralDirectory(workspace, stateHome, "1"), filename),
      join(stateHome, "u", "0", "projects", "f".repeat(64), "agent-runs", filename),
      join(centralDirectory(workspace, join(root, "other-home")), filename),
      `agent-runs/${filename}`,
      `${central}/../agent-runs/${filename}`,
      `${central}/./${filename}`,
      join(central, "not-a-run.json"),
    ]
    for (const entry of candidates) expect(() => resolveOmaReceiptPath(workspace, entry, options)).toThrow()
  })

  test.each([
    ["central", "u"],
    ["central", "u/0"],
    ["central", "u/0/projects"],
    ["central", "u/0/projects/{{project}}"],
    ["central", "u/0/projects/{{project}}/agent-runs"],
    ["legacy", ".agents"],
    ["legacy", ".agents/state"],
    ["legacy", ".agents/state/agent-runs"],
  ])("rejects a symlink in %s storage at %s", (store, subpath) => {
    const { root, workspace, stateHome } = fixture()
    const options = { env: { OMA_STATE_HOME: stateHome } }
    const directory = store === "central" ? centralDirectory(workspace, stateHome) : legacyDirectory(workspace)
    const receipt = writeRun(directory)
    const ancestor = join(
      store === "central" ? stateHome : workspace,
      subpath.replace("{{project}}", projectKey(workspace)),
    )
    const redirected = join(root, "redirected")
    renameSync(ancestor, redirected)
    symlinkSync(redirected, ancestor, "dir")
    expect(() => listOmaRunFiles(workspace, options)).toThrow()
    expect(() => resolveOmaReceiptPath(workspace, receipt, options)).toThrow()
  })
})
