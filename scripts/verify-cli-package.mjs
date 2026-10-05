#!/usr/bin/env node
// Run only after an authorized CLI build. Uses an offline local tarball and temporary native fixtures.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"

const packageRoot = resolve(process.argv[2] ?? "apps/cli/dist/npm")
const gitBinary = resolveGit()
const scratch = await mkdtemp(join(tmpdir(), "av-cli-package-"))
const home = join(scratch, "home")
const fixtures = join(scratch, "bin")
const consumer = join(scratch, "consumer")
const project = join(scratch, "repository")
const nodeDirectory = dirname(process.execPath)
const env = {
  PATH: [fixtures, nodeDirectory, "/usr/bin", "/bin"].join(delimiter),
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  KIMI_CODE_HOME: join(home, ".kimi-code"),
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_userconfig: join(scratch, "npmrc"),
  npm_config_offline: "true",
  CI: "true",
  LANG: "C.UTF-8",
}

function resolveGit() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "git")
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return realpathSync(candidate)
    } catch {
      // Continue through the caller's PATH before replacing it with the isolated fixture PATH.
    }
  }
  throw new Error("Git is missing from PATH. Install Git before running the standalone package smoke check.")
}

function command(binary, args, cwd = scratch) {
  return execFileSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4_194_304,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function verifyPausedResume(cli, nativeLog) {
  const now = new Date().toISOString()
  const reason = "Restore provider authentication before continuing."
  const mission = {
    id: "package-paused",
    repositoryRoot: project,
    goal: "Retain the paused package smoke checkpoint.",
    chiefId: "chief",
    workspace: {
      issueId: "package-paused",
      key: "package-paused",
      path: project,
      branch: "fixture",
      status: "idle",
      createdAt: now,
    },
    personas: [
      { id: "chief", name: "Chief Director", role: "Supervise the fixture", agentType: "kimi", skills: [] },
      { id: "reviewer", name: "Reviewer", role: "Review the fixture", agentType: "codex", skills: [] },
    ],
    verifyCommand: "true",
    timeoutSec: 10,
    maxRepairs: 0,
    status: "paused",
    createdAt: now,
    updatedAt: now,
    tasks: [],
    history: [{ at: now, stage: "paused", message: reason }],
    error: reason,
    executionPolicy: {
      maxParallel: 3,
      maxDurationSec: 86_400,
      maxRuns: 20,
      maxEstimatedCostUsd: 10,
      maxRetries: 3,
      retryDelayMs: 1_000,
      autoResume: true,
    },
    execution: {
      startedAt: now,
      runsStarted: 4,
      retries: 1,
      crashRestarts: 1,
      failureKind: "authentication",
      pauseReason: reason,
    },
  }
  const directory = join(project, ".agent-valley/missions")
  const path = join(directory, `${mission.id}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, JSON.stringify({ version: 1, mission }))
  const nativeBefore = await readFile(nativeLog, "utf8")
  for (const supervise of [true, false]) {
    const result = spawnSync(
      process.execPath,
      [cli, "order", "--once", "--resume", mission.id, ...(supervise ? [] : ["--no-supervise"])],
      {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1_048_576,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.status, 2, result.stderr + result.stdout)
    assert(result.stdout.includes("Order paused"))
    assert(result.stdout.includes(reason))
    assert(result.stdout.includes(`av order --resume ${mission.id} --retry`))
    const saved = JSON.parse(await readFile(path, "utf8"))
    assert.equal(saved.version, 1)
    assert.deepEqual(
      saved.mission,
      mission,
      "Resume without --retry must preserve the saved goal, checks, history and spent budget",
    )
    assert.deepEqual(
      await readdir(directory),
      [`${mission.id}.json`],
      "Order must release its mission lock and process markers",
    )
    assert.equal(await readFile(nativeLog, "utf8"), nativeBefore, "Paused orders must not invoke a native actor")
  }
}

async function verifyMcp(cli, version) {
  const child = spawn(process.execPath, [cli, "mcp", "--workspace", project], { cwd: consumer, env })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let id = 0
  let diagnostic = ""
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString()
  })
  const rejectPending = (error) => {
    for (const promise of pending.values()) promise.reject(error)
    pending.clear()
  }
  child.on("error", rejectPending)
  child.stdin.on("error", rejectPending)
  child.on("exit", () => rejectPending(new Error(`MCP exited before responding: ${diagnostic}`)))
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line)
      assert.equal(message.jsonrpc, "2.0", "MCP stdout must contain JSON-RPC only")
      const promise = pending.get(message.id)
      if (promise) {
        pending.delete(message.id)
        if (message.error) promise.reject(new Error(JSON.stringify(message.error)))
        else promise.resolve(message.result)
      }
    } catch (error) {
      rejectPending(error)
    }
  })
  const request = async (method, params) => {
    const requestId = ++id
    let timer
    try {
      return await new Promise((resolveRequest, reject) => {
        timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`MCP request ${method} timed out: ${diagnostic}`))
        }, 10_000)
        pending.set(requestId, { resolve: resolveRequest, reject })
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
      })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "av-package-smoke", version: "1" },
    })
    assert.equal(initialized.serverInfo.version, version, "MCP and npm package versions must match")
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const tools = await request("tools/list", {})
    for (const name of [
      "av_order",
      "av_missions",
      "av_status",
      "av_report",
      "av_resume",
      "av_cancel",
      "av_operations",
      "av_operation_status",
      "av_operation_report",
      "av_operation_resume",
      "av_operation_cancel",
    ])
      assert(
        tools.tools.some((tool) => tool.name === name),
        `${name} is missing from the distributed MCP server`,
      )
    assert.equal(tools.tools.length, 11, "The distributed MCP server must expose one order submission tool")
    assert(!tools.tools.some((tool) => tool.name === "av_operate"), "Use av_order for both execution modes")
    const missions = await request("tools/call", { name: "av_missions", arguments: {} })
    assert(!missions.isError, "Read-only MCP listing must succeed outside the monorepo")
    assert.deepEqual(missions.structuredContent.missions, [], "Smoke checks must never launch a mission")
    const operations = await request("tools/call", { name: "av_operations", arguments: {} })
    assert(!operations.isError, "Read-only operation listing must succeed outside the monorepo")
    assert.deepEqual(operations.structuredContent.operations, [], "Smoke checks must never launch an operation")
  } finally {
    lines.close()
    child.stdin.end()
    const exited = new Promise((resolveExit) => child.once("close", resolveExit))
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    if (child.exitCode === null) await exited
    clearTimeout(timer)
  }
}

try {
  for (const directory of [home, fixtures, consumer, project, env.KIMI_CODE_HOME])
    await mkdir(directory, { recursive: true })
  await symlink(gitBinary, join(fixtures, "git"))
  await writeFile(env.npm_config_userconfig, "")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  assert.equal(manifest.name, "agent-valley")
  assert.equal(manifest.type, "module")
  assert(!manifest.dependencies, "Bundled distribution must not ask npm to resolve workspace dependencies")
  assert(!manifest.scripts, "Published installation must not build or run lifecycle hooks")
  assert(manifest.engines.node && manifest.engines.bun, "Document both runtime requirements")
  const [packed] = JSON.parse(
    command("npm", ["pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", scratch]),
  )
  for (const file of [
    "dist/index.js",
    "dist/supervisor.js",
    "dist/assets/skills/av/SKILL.md",
    "dist/assets/plugin.json",
    "dist/assets/LICENSE",
    "LICENSE",
    "README.md",
  ])
    assert(
      packed.files.some((entry) => entry.path === file),
      `${file} is missing from the actual npm tarball`,
    )
  const tarball = join(scratch, packed.filename)
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }))
  command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer)
  const installed = join(consumer, "node_modules/agent-valley")
  const cli = join(installed, "dist/index.js")
  assert.equal(command(process.execPath, [cli, "--version"], consumer).trim(), manifest.version)
  assert(command(process.execPath, [cli, "--help"], consumer).includes("order"))
  assert.equal(command(join(consumer, "node_modules/.bin/av"), ["--version"], consumer).trim(), manifest.version)
  command("git", ["init", "--quiet"], project)
  await writeFile(join(project, "README.md"), "# Package smoke fixture\n")
  command("git", ["add", "README.md"], project)
  command(
    "git",
    ["-c", "user.name=AV Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"],
    project,
  )
  const nativeLog = join(scratch, "native-probes.jsonl")
  await writeFile(nativeLog, "")
  const nativeFixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ args }) + '\\n');
if (args.length === 1 && args[0] === '--help') { console.log('Usage: read-only package fixture'); }
else { console.error('The package smoke must not execute an actor task.'); process.exitCode = 97; }
`
  for (const binary of ["claude", "codex", "qwen", "agy", "cursor-agent", "grok", "kimi", "opencode"]) {
    const path = join(fixtures, binary)
    await writeFile(path, nativeFixture)
    await chmod(path, 0o755)
  }
  await writeFile(
    join(env.KIMI_CODE_HOME, "config.toml"),
    'default_model="fixture"\n[models.fixture]\nprovider="fixture"\nmodel="fixture-model"\n[providers.fixture]\ntype="kimi"\nbase_url="https://invalid.example.test"\napi_key="fixture-only-unused-key"\n',
  )
  const setup = JSON.parse(
    command(
      process.execPath,
      [cli, "setup", "--yes", "--actor", "kimi", "--model", "fixture-model", "--oma", "skip", "--json"],
      project,
    ),
  )
  assert.equal(setup.status, "ready")
  assert.equal(setup.chief.actorType, "kimi")
  assert.equal(setup.chief.readiness, "ready", "Kimi discovery must parse actual TOML without a Bun global")
  assert.equal(setup.oma.status, "skipped")
  assert.equal(setup.integrations.status, "installed")
  const output = join(scratch, "plugins")
  command(process.execPath, [cli, "plugins", "export", "--workspace", project, "--output", output], consumer)
  for (const root of ["portable/av", "claude/plugins/av", "cursor/plugins/av", "qwen/av", "antigravity/av"]) {
    assert((await readFile(join(output, root, "skills/av/SKILL.md"), "utf8")).includes("AGENT_VALLEY_MANAGED_RUN"))
    assert.equal(
      await readFile(join(output, root, "LICENSE"), "utf8"),
      await readFile(join(installed, "LICENSE"), "utf8"),
    )
  }
  for (const file of [
    "portable/av/plugin.json",
    "claude/plugins/av/.claude-plugin/plugin.json",
    "cursor/plugins/av/.cursor-plugin/plugin.json",
    "qwen/av/qwen-extension.json",
  ])
    assert.equal(JSON.parse(await readFile(join(output, file), "utf8")).version, manifest.version)
  await verifyMcp(cli, manifest.version)
  await verifyPausedResume(cli, nativeLog)
  for (const line of (await readFile(nativeLog, "utf8")).trim().split("\n").filter(Boolean))
    assert.deepEqual(JSON.parse(line).args, ["--help"], "Only read-only discovery probes may invoke native fixtures")
  console.log(
    JSON.stringify({
      status: "passed",
      version: manifest.version,
      checks: [
        "offline tarball installation",
        "Node CLI and bin",
        "Node Kimi TOML discovery",
        "client assets",
        "plugin export and licenses",
        "MCP initialize, unified order tools and read-only missions/operations",
        "Node supervised and direct paused resume with preserved checkpoint and released locks",
      ],
    }),
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
