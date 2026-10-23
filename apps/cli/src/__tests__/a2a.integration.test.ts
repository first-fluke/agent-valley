import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  artifactResponse,
  fixtureEndpoint,
  fixtureRepository,
} from "@agent-valley/core/executions/__tests__/a2a.fixture"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const checkout = resolve(import.meta.dirname, "../../../..")
const entrypoint = join(checkout, "apps/cli/src/index.ts")
const bun = execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
  cwd: checkout,
  encoding: "utf8",
  timeout: 5_000,
}).trim()
const secret = "PRIVATE_CLI_FIXTURE_AUTH_TOKEN"
let root: string
let settings: string
let server: Awaited<ReturnType<typeof fixtureEndpoint>> | undefined
const children = new Set<ChildProcess>()

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

function source(args: string[]) {
  const child = spawn(bun, [entrypoint, "a2a", ...args], {
    cwd: root,
    env: { ...process.env, AV_A2A_CLI_FIXTURE_TOKEN: secret },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const result = new Promise<Result>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`Source A2A command timed out: ${args[0]}`))
    }, 15_000)
    child.once("error", (error) => {
      clearTimeout(timer)
      children.delete(child)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      children.delete(child)
      resolveResult({ code, stdout, stderr })
    })
  })
  return { child, result }
}

async function endpointFile() {
  if (!server) throw new Error("Create the fixture endpoint first")
  const file = join(settings, "endpoint.json")
  await writeFile(file, JSON.stringify({ ...server.endpoint, authTokenEnv: "AV_A2A_CLI_FIXTURE_TOKEN" }))
  return file
}

async function runArgs() {
  return ["run", "Write 42", "--endpoint", await endpointFile(), "--allow", "result.txt", "--verify", "node verify.cjs"]
}

function output(result: Result) {
  expect(result.stdout + result.stderr).not.toContain(secret)
  return result.stdout.trim().split("\n").at(-1) ?? ""
}

beforeEach(async () => {
  root = await fixtureRepository()
  settings = await mkdtemp(join(tmpdir(), "av-a2a-cli-settings-"))
})

afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolveClose) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveClose()
          child.once("close", resolveClose)
          child.kill("SIGKILL")
        }),
    ),
  )
  children.clear()
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
  await rm(settings, { recursive: true, force: true, maxRetries: 3 })
})

describe("source A2A CLI with local protocol endpoint", () => {
  it("runs, inspects and resumes a verified terminal result without another submission", async () => {
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    const run = await source(await runArgs()).result
    const saved = await server.saved()
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`A2A execution ${saved.id}`)
    expect(JSON.parse(output(run))).toMatchObject({ id: saved.id, status: "completed", verified: true })
    expect(await server.bytes()).toBe("42\n")
    for (const command of ["status", "resume"]) {
      const result = await source([command, saved.id]).result
      expect(result.code).toBe(0)
      expect(JSON.parse(output(result))).toMatchObject({ id: saved.id, status: "completed", verified: true })
    }
    expect(server.requests.map((request) => request.method)).toEqual(["SendMessage"])
    expect(await readFile(join(root, ".agent-valley/a2a", `${saved.id}.json`), "utf8")).not.toContain(secret)
  })

  it("keeps a lost submission blocked across status, resume and explicit reconciliation", async () => {
    server = await fixtureEndpoint(root, (_rpc, _job, response) => {
      response.destroy()
      return {}
    })
    const run = await source(await runArgs()).result
    const saved = await server.saved()
    expect(run.code).toBe(1)
    expect(run.stdout).toContain(saved.id)
    expect(run.stderr).toContain("unknown")
    output(run)
    const status = await source(["status", saved.id]).result
    expect(status.code).toBe(1)
    expect(JSON.parse(output(status))).toMatchObject({ id: saved.id, status: "unknown", phase: "unknown" })
    const resume = await source(["resume", saved.id]).result
    expect(resume.code).toBe(1)
    expect(resume.stderr).toContain("will not be repeated")
    output(resume)
    const duplicate = await source(await runArgs()).result
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toContain("unresolved")
    const evidence = "PRIVATE_OPERATOR_PROOF: independently observed the fixture task stopped."
    const reconcile = await source(["reconcile", saved.id, "--evidence", evidence]).result
    expect(reconcile.code).toBe(1)
    expect(JSON.parse(output(reconcile))).toMatchObject({ id: saved.id, status: "reconciled", verified: false })
    expect(reconcile.stdout + reconcile.stderr).not.toContain(evidence)
    expect(server.requests.map((request) => request.method)).toEqual(["SendMessage"])
    expect(await server.bytes()).toBe("0\n")
  })

  it("reconnects an accepted task by GetTask without repeating SendMessage", async () => {
    let disconnected = true
    server = await fixtureEndpoint(root, (rpc, job, response) => {
      if (rpc.method === "SendMessage") return { task: { id: "fixture-task", status: { state: "TASK_STATE_WORKING" } } }
      if (disconnected) {
        response.destroy()
        return {}
      }
      return { ...artifactResponse(job), id: "fixture-task" }
    })
    expect((await source(await runArgs()).result).code).toBe(1)
    const saved = await server.saved()
    expect(saved.status).toBe("unknown")
    expect(saved.checkpoint?.taskId).toBe("fixture-task")
    disconnected = false
    const resumed = await source(["resume", saved.id]).result
    expect(resumed.code).toBe(0)
    expect(JSON.parse(output(resumed))).toMatchObject({ status: "completed", verified: true })
    expect(server.requests.filter((request) => request.method === "SendMessage")).toHaveLength(1)
    expect(server.requests.filter((request) => request.method === "GetTask")).toHaveLength(2)
  })

  it("preserves the lock while active and records an unknown outcome after SIGINT", async () => {
    let polling: (() => void) | undefined
    const observedPolling = new Promise<void>((resolvePolling) => {
      polling = resolvePolling
    })
    server = await fixtureEndpoint(root, (rpc, _job, response) => {
      if (rpc.method === "SendMessage") return { task: { id: "fixture-task", status: { state: "TASK_STATE_WORKING" } } }
      if (rpc.method === "GetTask") {
        polling?.()
        return new Promise<void>((resolveClosed) => response.once("close", resolveClosed))
      }
      return { id: "fixture-task", status: { state: "TASK_STATE_WORKING" } }
    })
    const active = source(await runArgs())
    await Promise.race([
      observedPolling,
      active.result.then(() => {
        throw new Error("The source command exited before the accepted task was polled")
      }),
    ])
    const saved = await server.saved()
    const locked = await source(["reconcile", saved.id, "--evidence", "Task was observed stopped."]).result
    expect(locked.code).toBe(1)
    expect(locked.stderr).toContain("already running")
    active.child.kill("SIGINT")
    const interrupted = await active.result
    expect(interrupted.code).toBe(1)
    expect(interrupted.stderr).toContain("unknown")
    output(interrupted)
    expect((await server.saved()).status).toBe("unknown")
    expect(server.requests.filter((request) => request.method === "SendMessage")).toHaveLength(1)
    expect(await server.bytes()).toBe("0\n")
  })

  it.skipIf(process.platform === "win32")("rejects a FIFO endpoint file without waiting for a writer", async () => {
    const fifo = join(settings, "endpoint.pipe")
    await exec("mkfifo", [fifo])
    const running = source([
      "run",
      "Write 42",
      "--endpoint",
      fifo,
      "--allow",
      "result.txt",
      "--verify",
      "node verify.cjs",
    ])
    const timer = setTimeout(() => running.child.kill("SIGKILL"), 3_000)
    const result = await running.result
    clearTimeout(timer)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("regular file")
  })
})
