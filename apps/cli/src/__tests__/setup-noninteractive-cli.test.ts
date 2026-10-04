import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"
import type { NoninteractiveSetupResult } from "../setup/noninteractive-types"

const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
let bun: string
let root: string
let project: string
let repository: string
let globalConfig: string
let commandLog: string
let env: Record<string, string>
let client: Client | undefined

function executable(name: string): string {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, name))
    .find(existsSync)
  if (!path) throw new Error(`Fixture requires ${name} on PATH.`)
  return realpathSync(path)
}

function createRepository(path: string): void {
  mkdirSync(path)
  const options = { cwd: path, env }
  execFileSync("git", ["init", "--quiet"], options)
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    options,
  )
}

function providerShim(vendor: "codex" | "claude"): string {
  const log = `'${commandLog.replaceAll("'", "'\\''")}'`
  const authRequired = `'${join(root, "codex-auth-required").replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
record='${vendor}'
for argument in "$@"; do record="$record\t$argument"; done
printf '%s\\n' "$record" >> ${log}
case "$*" in
  --version) printf '%s\\n' '${vendor} fixture';;
  --help) printf '%s\\n' '  login  Manage login' '  auth  Manage authentication';;
  'login --help'|'auth --help') printf '%s\\n' '  status  Inspect authentication';;
  'login status')
    if [ -f ${authRequired} ]; then printf '%s\\n' 'Not logged in'; exit 1; fi
    printf '%s\\n' 'Logged in using fixture credentials';;
  'auth status') printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai"}';;
  *) printf '%s\\n' 'DENIED: non-read-only native command' >> ${log}; exit 91;;
esac
`
}

function saveDefaults(actorType: string, model: string): void {
  writeFileSync(
    join(project, "av.yaml"),
    stringify({ workspace: { root: repository }, actor: { type: actorType, model } }),
  )
  mkdirSync(join(root, "xdg-config", "agent-valley"), { recursive: true })
  writeFileSync(globalConfig, stringify({ actor: { type: actorType, model }, server: { port: 9900 } }))
}

function runSetup(args: string[], overrides: Record<string, string> = {}) {
  return spawnSync(bun, [entry, "setup", ...args], {
    cwd: project,
    env: { ...env, ...overrides },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  })
}

function jsonResult(args: string[], overrides: Record<string, string> = {}): NoninteractiveSetupResult {
  const child = runSetup(["--yes", "--oma", "skip", "--json", ...args], overrides)
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.stderr).toBe("")
  // Parsing the whole stdout rejects prompt/progress text or a second JSON object.
  const result = JSON.parse(child.stdout) as NoninteractiveSetupResult
  expect(result.version).toBe(1)
  expect(child.status).toBe(result.exitCode)
  return result
}

function snapshot(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const files: Record<string, string> = {}
  for (const child of readdirSync(path, { withFileTypes: true })) {
    if (child.name === ".git" || child.name === "bin") continue
    const target = join(path, child.name)
    if (child.isDirectory()) Object.assign(files, snapshot(target))
    else files[target] = createHash("sha256").update(readFileSync(target)).digest("hex")
  }
  return files
}

beforeAll(() => {
  // Resolve the real Bun before replacing PATH; no compilation or installation is needed.
  bun = execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" })
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "av-headless-cli-")))
  project = join(root, "configuration-a")
  repository = join(root, "repository-b")
  globalConfig = join(root, "xdg-config", "agent-valley", "settings.yaml")
  commandLog = join(root, "native-commands.log")
  const shims = join(root, "bin")
  const home = join(root, "home")
  mkdirSync(shims)
  mkdirSync(home)
  writeFileSync(commandLog, "")
  symlinkSync(executable("git"), join(shims, "git"))
  for (const vendor of ["codex", "claude"] as const)
    writeFileSync(join(shims, vendor), providerShim(vendor), { mode: 0o755 })
  for (const command of ["oma", "curl", "npm", "npx", "bunx", "wget"])
    writeFileSync(
      join(shims, command),
      `#!/bin/sh\nprintf '%s\\n' 'DENIED: ${command}' >> '${commandLog.replaceAll("'", "'\\''")}'\nexit 91\n`,
      { mode: 0o755 },
    )
  // Deliberately do not inherit runtime markers, API keys, auth paths, or user configuration.
  env = {
    PATH: [shims, "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CI: "true",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
  createRepository(project)
  createRepository(repository)
})

afterEach(async () => {
  await client?.close()
  client = undefined
  const commands = readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean)
  try {
    expect(
      commands.filter(
        (command) => !/^(codex|claude)\t(--help|--version|login\t(--help|status)|auth\t(--help|status))$/.test(command),
      ),
    ).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("real unattended setup CLI", () => {
  it("preserves the initiating identity through a different worker runtime and binds repository B to configuration A", async () => {
    saveDefaults("claude", "stale-worker-model")
    const result = jsonResult(
      [
        "--actor",
        "codex",
        "--model",
        "confirmed-initiator-model",
        "--workspace",
        repository,
        "--verify",
        "test -s evidence.txt",
      ],
      { CLAUDECODE: "1" },
    )
    expect(result).toMatchObject({
      status: "ready",
      exitCode: 0,
      projectRoot: project,
      workspace: repository,
      config: { project: join(project, "av.yaml"), global: globalConfig, saved: true },
      chief: {
        actorType: "codex",
        model: "confirmed-initiator-model",
        actorSource: "explicit",
        modelSource: "explicit",
        readiness: "ready",
      },
      oma: { status: "skipped" },
      integrations: { status: "installed" },
    })
    const config = parse(readFileSync(join(project, "av.yaml"), "utf8"))
    expect(config.actor).toMatchObject({ type: "codex", model: "confirmed-initiator-model" })
    expect(config.verify.command).toBe("test -s evidence.txt")
    const global = parse(readFileSync(globalConfig, "utf8"))
    expect(global.actor).toMatchObject({ type: "codex", model: "confirmed-initiator-model" })
    expect(global.server.port).toBe(9900)
    const integration = JSON.parse(readFileSync(join(repository, ".mcp.json"), "utf8")).mcpServers.av
    expect(integration).toMatchObject({ command: "av", args: ["mcp", "--workspace", project] })
    expect(existsSync(join(repository, "av.yaml"))).toBe(false)
    expect(existsSync(join(project, ".mcp.json"))).toBe(false)
    client = new Client({ name: "av-headless-setup-test", version: "1" })
    await client.connect(
      new StdioClientTransport({
        command: bun,
        args: [entry, ...integration.args],
        cwd: repository,
        env,
        stderr: "pipe",
      }),
    )
    const missions = await client.callTool({ name: "av_missions", arguments: {} })
    expect(missions.structuredContent).toMatchObject({
      project,
      workspace: repository,
      executionContext: { managed: false, delegationAllowed: true },
    })
  }, 20_000)

  it("uses the current Codex runtime before saved vendor defaults and removes the stale model", () => {
    saveDefaults("claude", "stale-claude-model")
    const result = jsonResult([], { CODEX_THREAD_ID: "fixture-current-session" })
    expect(result).toMatchObject({
      status: "ready",
      chief: {
        actorType: "codex",
        actorSource: "runtime",
        model: null,
        modelSource: "runtime-native-default",
        runtimeIdentity: "CODEX_THREAD_ID",
      },
    })
    for (const path of [join(project, "av.yaml"), globalConfig]) {
      const config = parse(readFileSync(path, "utf8"))
      expect(config.actor.type).toBe("codex")
      expect(config.actor.model).toBeUndefined()
    }
  }, 20_000)

  it("honors an empty model argument by clearing a same-vendor saved pin", () => {
    saveDefaults("codex", "obsolete-codex-pin")
    const result = jsonResult(["--actor", "codex", "--model", ""])
    expect(result).toMatchObject({
      status: "ready",
      chief: { actorType: "codex", model: null, modelSource: "explicit-native-default" },
    })
    for (const path of [join(project, "av.yaml"), globalConfig])
      expect(parse(readFileSync(path, "utf8")).actor.model).toBeUndefined()
  }, 20_000)

  it("saves setup and reports authentication as a pending action without launching login", () => {
    writeFileSync(join(root, "codex-auth-required"), "")
    const result = jsonResult(["--actor", "codex", "--model", "current-model", "--workspace", repository], {})
    expect(result).toMatchObject({
      status: "action_required",
      exitCode: 2,
      config: { saved: true },
      chief: { actorType: "codex", readiness: "unauthenticated" },
      integrations: { status: "installed" },
    })
    expect(result.nextActions.some((action) => action.includes("codex login"))).toBe(true)
    expect(
      result.nextActions.some((action) => action.includes("setup --yes") && action.includes("current-model")),
    ).toBe(true)
    expect(parse(readFileSync(join(project, "av.yaml"), "utf8")).actor).toMatchObject({
      type: "codex",
      model: "current-model",
    })
    expect(existsSync(globalConfig)).toBe(true)
    expect(existsSync(join(repository, ".mcp.json"))).toBe(true)
    expect(readFileSync(commandLog, "utf8")).toContain("codex\tlogin\tstatus")
  }, 20_000)

  it.each([
    { name: "tracker mode", args: ["--mode", "tracker"] },
    { name: "interactive edit", args: ["--edit"] },
    { name: "unknown actor", args: ["--actor", "unknown-vendor"] },
    { name: "invalid OMA mode", args: ["--oma", "invalid"] },
    { name: "empty workspace", args: ["--workspace", ""] },
    { name: "empty verification", args: ["--verify", ""] },
  ])(
    "rejects $name before changing config or running native commands",
    ({ args }) => {
      saveDefaults("codex", "retain-this-model")
      const before = snapshot(root)
      const result = jsonResult(args)
      expect(result).toMatchObject({
        status: "failed",
        exitCode: 1,
        config: { saved: false },
        chief: { readiness: "not_checked" },
      })
      expect(result.error).toBeTruthy()
      expect(result.nextActions).toContain(result.error)
      expect(snapshot(root)).toEqual(before)
      expect(readFileSync(commandLog, "utf8")).toBe("")
    },
    20_000,
  )

  it("rejects an unknown CLI flag before effects with stdin closed", () => {
    const before = snapshot(root)
    const child = runSetup(["--yes", "--oma", "skip", "--json", "--unknown-setup-flag"])
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(child.stdout).toBe("")
    expect(child.stderr).toContain("unknown option")
    expect(snapshot(root)).toEqual(before)
    expect(readFileSync(commandLog, "utf8")).toBe("")
  }, 20_000)
})
