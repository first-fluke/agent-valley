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
const controllers = new Set<AbortController>()
const workers: Promise<number | null>[] = []
let directory: string
const publishPid = [
  "const pending = `${process.argv[2]}.pending`",
  "writeFileSync(pending, String(process.pid))",
  "renameSync(pending, process.argv[2])",
].join("\n")

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

async function readyPid(path: string, read = () => readFile(path, "utf8")): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const content = await read().catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (content?.trim()) {
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

function startWorker(args: string[], entry: string) {
  const controller = new AbortController()
  // Register cancellation before spawn/readiness so a failed ready check cannot leak the child.
  controllers.add(controller)
  const worker = runOrderWorker(args, directory, controller.signal, {
    entry,
    terminateGraceMs: 50,
    killWaitMs: 1_000,
  })
  workers.push(worker)
  return { controller, worker }
}

async function cleanupOwnedProcesses(): Promise<void> {
  const children = new Set([
    ...canaries.splice(0),
    ...vi.mocked(spawn).mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
  ])
  const closed = [...children].map((child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve())),
  )
  for (const controller of controllers) controller.abort()
  controllers.clear()
  const settled: PromiseSettledResult<unknown>[] = await Promise.allSettled(
    workers.splice(0).map((worker) => bounded(worker, 2_000)),
  )
  // Only handles returned by this test's spawn mock are eligible for fallback cleanup.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  settled.push(...(await Promise.allSettled(closed.map((promise) => bounded(promise, 2_000)))))
  for (const result of settled) if (result.status === "rejected") throw result.reason
}

beforeEach(async () => {
  vi.useRealTimers()
  vi.mocked(spawn).mockClear()
  directory = await mkdtemp(join(tmpdir(), "av-worker-lifecycle-"))
})

afterEach(async () => {
  try {
    await cleanupOwnedProcesses()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("owned order worker lifecycle", () => {
  it("waits for the PID after observing the ready file between creation and its first write", async () => {
    const ready = join(directory, "partial.ready")
    await writeFile(ready, "")
    let reads = 0
    const pid = await readyPid(ready, async () => {
      const content = await readFile(ready, "utf8")
      if (++reads === 1) {
        expect(content).toBe("")
        await writeFile(ready, String(process.pid))
      }
      return content
    })
    expect(pid).toBe(process.pid)
    expect(reads).toBe(2)
  })

  it.each(["0", "-1", "not-a-pid"])(
    "rejects a published invalid PID without treating it as pending: %s",
    async (content) => {
      const read = vi.fn(async () => content)
      await expect(readyPid("unused", read)).rejects.toThrow("positive owned PID")
      expect(read).toHaveBeenCalledOnce()
    },
  )

  it("cancels and joins the owned worker even when its ready receipt is invalid", async () => {
    const entry = join(directory, "invalid-ready.mjs")
    const ready = join(directory, "invalid.ready")
    await writeFile(
      entry,
      [
        'import { writeFileSync } from "node:fs"',
        'process.on("SIGTERM", () => {})',
        'writeFileSync(process.argv[2], "not-a-pid")',
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const { controller, worker } = startWorker([ready], entry)
    const result = vi.mocked(spawn).mock.results.at(-1)
    const owned = result?.type === "return" ? result.value : undefined
    if (!owned?.pid) throw new Error("Expected the directly owned worker handle")
    await expect(readyPid(ready)).rejects.toThrow("positive owned PID")
    expect(alive(owned.pid)).toBe(true)

    await cleanupOwnedProcesses()

    expect(controller.signal.aborted).toBe(true)
    expect(await worker).toBeNull()
    expect(alive(owned.pid)).toBe(false)
  })

  it("kills and joins a SIGTERM-ignoring worker while leaving a separate owned canary alive", async () => {
    const entry = join(directory, "ignore-term.mjs")
    const ready = join(directory, "worker.ready")
    const term = join(directory, "worker.term")
    await writeFile(
      entry,
      [
        'import { renameSync, writeFileSync } from "node:fs"',
        'process.on("SIGTERM", () => writeFileSync(process.argv[3], "ignored TERM"))',
        publishPid,
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const canaryEntry = join(directory, "canary.mjs")
    const canaryReady = join(directory, "canary.ready")
    await writeFile(
      canaryEntry,
      `import { renameSync, writeFileSync } from "node:fs"\n${publishPid}\nsetInterval(() => {}, 1000)\n`,
    )
    const canary = spawn(process.execPath, [canaryEntry, canaryReady], { cwd: directory, stdio: "ignore" })
    canaries.push(canary)
    const canaryPid = await readyPid(canaryReady)
    const { controller, worker } = startWorker([ready, term], entry)
    const pid = await readyPid(ready)
    expect(alive(pid)).toBe(true)
    expect(alive(canaryPid)).toBe(true)

    controller.abort()
    const exit = await bounded(worker, 2_000)

    expect(exit).toBeNull()
    expect(await readFile(term, "utf8")).toBe("ignored TERM")
    expect(alive(pid)).toBe(false)
    expect(alive(canaryPid)).toBe(true)
    expect(canary.exitCode).toBeNull()
    expect(canary.signalCode).toBeNull()
  })

  it("preserves the exit code after a normal worker exit", async () => {
    const entry = join(directory, "normal-exit.mjs")
    const ready = join(directory, "normal.ready")
    await writeFile(
      entry,
      `import { renameSync, writeFileSync } from "node:fs"\n${publishPid}\nprocess.exitCode = Number(process.argv[3])\n`,
    )
    const { worker } = startWorker([ready, "17"], entry)

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
