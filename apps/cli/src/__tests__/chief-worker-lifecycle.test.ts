import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runOrderWorker } from "../chief-worker-lifecycle"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const canaries: ChildProcess[] = []
const workerPids = new Set<number>()
const workers: Promise<number | null>[] = []
let directory: string

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The owned fixture process did not settle in time.")), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readyPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (content !== undefined) {
      const pid = Number(content)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The fixture did not report a positive owned PID.")
      return pid
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("The owned fixture process did not become ready.")
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

beforeEach(async () => {
  vi.useRealTimers()
  vi.mocked(spawn).mockClear()
  directory = await mkdtemp(join(tmpdir(), "av-worker-lifecycle-"))
})

afterEach(async () => {
  for (const child of canaries) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  for (const pid of workerPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  await Promise.allSettled([
    ...workers.splice(0).map((worker) => bounded(worker, 2_000)),
    ...canaries
      .splice(0)
      .map((child) =>
        bounded(
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) => child.once("close", () => resolve())),
          2_000,
        ),
      ),
  ])
  workerPids.clear()
  await rm(directory, { recursive: true, force: true })
})

describe("owned order worker lifecycle", () => {
  it("kills and joins a SIGTERM-ignoring worker while leaving a separate owned canary alive", async () => {
    const entry = join(directory, "ignore-term.mjs")
    const ready = join(directory, "worker.ready")
    const term = join(directory, "worker.term")
    await writeFile(
      entry,
      [
        'import { writeFileSync } from "node:fs"',
        'process.on("SIGTERM", () => writeFileSync(process.argv[3], "ignored TERM"))',
        "writeFileSync(process.argv[2], String(process.pid))",
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const canaryEntry = join(directory, "canary.mjs")
    const canaryReady = join(directory, "canary.ready")
    await writeFile(
      canaryEntry,
      'import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], String(process.pid))\nsetInterval(() => {}, 1000)\n',
    )
    const canary = spawn(process.execPath, [canaryEntry, canaryReady], { cwd: directory, stdio: "ignore" })
    canaries.push(canary)
    const canaryPid = await readyPid(canaryReady)
    const controller = new AbortController()
    const worker = runOrderWorker([ready, term], directory, controller.signal, {
      entry,
      terminateGraceMs: 50,
      killWaitMs: 1_000,
    })
    workers.push(worker)
    const pid = await readyPid(ready)
    workerPids.add(pid)
    expect(alive(pid)).toBe(true)
    expect(alive(canaryPid)).toBe(true)

    controller.abort()
    const exit = await bounded(worker, 2_000)

    expect(exit).toBeNull()
    expect(await readFile(term, "utf8")).toBe("ignored TERM")
    expect(alive(pid)).toBe(false)
    workerPids.delete(pid)
    expect(alive(canaryPid)).toBe(true)
    expect(canary.exitCode).toBeNull()
    expect(canary.signalCode).toBeNull()
  })

  it("preserves the exit code after a normal worker exit", async () => {
    const entry = join(directory, "normal-exit.mjs")
    const ready = join(directory, "normal.ready")
    await writeFile(
      entry,
      'import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], String(process.pid))\nprocess.exitCode = Number(process.argv[3])\n',
    )
    const worker = runOrderWorker([ready, "17"], directory, new AbortController().signal, {
      entry,
      terminateGraceMs: 50,
      killWaitMs: 1_000,
    })
    workers.push(worker)

    expect(await bounded(worker, 2_000)).toBe(17)
    expect(alive(await readyPid(ready))).toBe(false)
  })

  it("does not launch a child when its signal is already aborted", async () => {
    const entry = join(directory, "must-not-launch.mjs")
    const marker = join(directory, "unexpected-launch")
    await writeFile(entry, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], "launched")\n')
    const controller = new AbortController()
    controller.abort()

    const exit = await runOrderWorker([marker], directory, controller.signal, {
      entry,
      terminateGraceMs: 50,
      killWaitMs: 1_000,
    })

    expect(exit).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
