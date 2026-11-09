import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { type ContainerObservationCommand, executeContainerCommand } from "./container-observation-command"

const directories: string[] = []
const command: ContainerObservationCommand = { binary: "docker", args: [], timeoutMs: 2_000, maxOutputBytes: 1_024 }
let shimDirectory: Promise<string> | undefined

async function prepareWindowsShim(): Promise<string> {
  shimDirectory ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "av-container-shim-"))
    let located: string[] = []
    try {
      located = execFileSync("where", ["node"], { encoding: "utf8" }).split(/\r?\n/)
    } catch {
      located = []
    }
    const candidates = [process.env.NODE, "C:\\Program Files\\nodejs\\node.exe", ...located].filter(
      (path): path is string => typeof path === "string" && existsSync(path),
    )
    const node = candidates.find((path) => !path.toLowerCase().includes("mise")) ?? candidates[0]
    if (!node) throw new Error("Windows container tests require a Node executable on PATH.")
    await copyFile(node, join(directory, "docker.exe"))
    await writeFile(
      join(directory, "shim.cjs"),
      `const Module = require("node:module")
const path = require("node:path")
process.env.AV_DOCKER_ORIGINAL_ARGV = JSON.stringify(process.argv.slice(1))
const main = path.join(__dirname, "main.cjs")
if (process.argv.length < 2) require(main)
const original = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  try {
    return original.call(this, request, ...args)
  } catch (error) {
    if (request === process.argv[1]) return main
    throw error
  }
}
`,
    )
    await writeFile(
      join(directory, "main.cjs"),
      `const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const args = JSON.parse(process.env.AV_DOCKER_ORIGINAL_ARGV).map((arg) => {
  if (!path.isAbsolute(arg) || fs.existsSync(arg)) return arg
  const relative = path.relative(process.cwd(), arg)
  return relative && !relative.startsWith("..") ? relative : arg
})
process.argv = [process.execPath, "docker", ...args]
vm.runInThisContext(fs.readFileSync(process.env.AV_DOCKER_SOURCE, "utf8"), { filename: "docker-source.js" })
`,
    )
    return directory
  })()
  return shimDirectory
}

async function fixture(source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "av-container-command-"))
  directories.push(directory)
  if (process.platform === "win32") {
    const shim = await prepareWindowsShim()
    const sourcePath = join(directory, "source.js")
    await writeFile(sourcePath, source)
    vi.stubEnv("PATH", `${shim}${delimiter}${process.env.PATH ?? ""}`)
    vi.stubEnv("NODE_OPTIONS", `--require=${join(shim, "shim.cjs")}`)
    vi.stubEnv("AV_DOCKER_SOURCE", sourcePath)
  } else {
    await writeFile(join(directory, "docker"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 })
    vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`)
  }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
afterAll(async () => {
  if (shimDirectory) await rm(await shimDirectory, { recursive: true, force: true })
})

describe("bounded native container observation subprocess", () => {
  it("uses argv literally without shell expansion and closes stdin", async () => {
    await fixture(
      'process.stdin.on("end",()=>process.stdout.write(JSON.stringify(process.argv.slice(2))));process.stdin.resume()',
    )
    const output = await executeContainerCommand({ ...command, args: ["literal; echo forbidden", "$(echo forbidden)"] })
    expect(JSON.parse(output.stdout)).toEqual(["literal; echo forbidden", "$(echo forbidden)"])
    expect(output.stderr).toBe("")
  })

  it("caps combined stdout and stderr even when neither stream alone exceeds the limit", async () => {
    await fixture(
      'process.stdout.write("a".repeat(700));process.stderr.write("b".repeat(700));setInterval(()=>{},1000)',
    )
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "output-limit" })
  })

  it("counts output bytes rather than Unicode characters", async () => {
    await fixture('process.stdout.write("😀".repeat(300));setInterval(()=>{},1000)')
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "output-limit" })
  })

  it("kills a hanging CLI on timeout and never returns its stderr", async () => {
    await fixture(
      'process.stderr.write("fixture-credential-must-not-leak");process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    )
    const started = Date.now()
    await expect(executeContainerCommand({ ...command, timeoutMs: 150 })).rejects.toMatchObject({ failure: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("kills an in-flight CLI on abort and handles already cancelled calls without spawn", async () => {
    await fixture("setInterval(()=>{},1000)")
    const controller = new AbortController()
    const running = executeContainerCommand({ ...command, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 40)
    try {
      await expect(running).rejects.toMatchObject({ failure: "cancelled" })
      await expect(executeContainerCommand({ ...command, signal: controller.signal })).rejects.toMatchObject({
        failure: "cancelled",
      })
    } finally {
      clearTimeout(timer)
    }
  })

  it("reports missing CLI and failed commands generically without stderr or secrets", async () => {
    const empty = await mkdtemp(join(tmpdir(), "av-container-missing-"))
    directories.push(empty)
    vi.stubEnv("PATH", empty)
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "missing-cli" })
    await fixture('process.stderr.write("fixture-credential-must-not-leak");process.exitCode=1')
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "failed" })
    try {
      await executeContainerCommand(command)
    } catch (error) {
      expect(String(error)).not.toContain("fixture-credential")
    }
  })
})
