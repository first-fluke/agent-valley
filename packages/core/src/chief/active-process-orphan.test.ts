import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ActiveMissionProcess } from "./active-process"
import { isProcessAlive, processIdentity } from "./process-identity"

vi.mock("./process-identity", () => ({ isProcessAlive: vi.fn(), processIdentity: vi.fn() }))
let directory: string
let guard: ActiveMissionProcess
let alive: boolean
const childPid = 987_654

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-orphan-"))
  guard = new ActiveMissionProcess(directory, "orphan-test")
  alive = true
  vi.mocked(isProcessAlive).mockReturnValue(false)
  vi.mocked(processIdentity).mockReturnValue("original-node-process")
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0 && !alive) throw Object.assign(new Error("dead"), { code: "ESRCH" })
    if (signal === "SIGTERM" || signal === "SIGKILL") alive = false
    return true
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe("abandoned mission process recovery", () => {
  it("terminates a proven original child of a dead coordinator and removes its marker", async () => {
    guard.begin("work")
    guard.spawned(childPid, true)
    await guard.recoverOrphan()
    expect(process.kill).toHaveBeenCalledWith(-childPid, "SIGTERM")
    expect(await readdir(directory)).toEqual([])
    expect(() => guard.assertIdle()).not.toThrow()
  })

  it("retains a reused PID without signalling the replacement process", async () => {
    guard.begin("work")
    guard.spawned(childPid, true)
    vi.mocked(processIdentity).mockReturnValue("a-reused-process")
    await expect(guard.recoverOrphan()).rejects.toThrow("uncertain orphan")
    expect(process.kill).not.toHaveBeenCalledWith(-childPid, "SIGTERM")
    expect(await readdir(directory)).toEqual(["orphan-test.active"])
  })

  it("retains unknown identity or an unrecorded PID instead of guessing ownership", async () => {
    guard.begin("work")
    await expect(guard.recoverOrphan()).rejects.toThrow("uncertain orphan")
    vi.mocked(processIdentity).mockReturnValue(undefined)
    guard.spawned(childPid, true)
    await expect(guard.recoverOrphan()).rejects.toThrow("uncertain orphan")
    expect(process.kill).not.toHaveBeenCalledWith(-childPid, "SIGTERM")
  })

  it("keeps a live coordinator's child blocked and removes only a proven dead child", async () => {
    guard.begin("work")
    guard.spawned(childPid, true)
    vi.mocked(isProcessAlive).mockReturnValue(true)
    await expect(guard.recoverOrphan()).rejects.toThrow("still has a running")
    expect(process.kill).not.toHaveBeenCalledWith(-childPid, "SIGTERM")
    alive = false
    await guard.recoverOrphan()
    expect(await readdir(directory)).toEqual([])
  })
})
