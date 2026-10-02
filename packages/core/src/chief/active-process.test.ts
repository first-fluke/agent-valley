import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ActiveMissionProcess } from "./active-process"
import { MissionStore } from "./store"

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "chief-process-"))
  path = join(directory, "mission.active")
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe("active mission process", () => {
  it("retains an uncertain spawn after a crash and gives manual recovery instructions", async () => {
    const guard = new MissionStore(directory).processGuard("mission")
    guard.begin("work")
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ stage: "work", pid: null })
    expect(() => new ActiveMissionProcess(directory, "mission").assertIdle()).toThrow(path)
    expect(() => guard.begin("review")).toThrow("before recording its worker PID")
    expect(await new MissionStore(directory).list()).toEqual([])
    guard.finish()
    expect(readdirSync(directory)).toEqual([])
  })

  it("blocks resume for a live worker and checks the full recorded process group", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("verify")
    guard.spawned(87654, true)
    const probe = vi.spyOn(process, "kill").mockReturnValue(true)

    expect(() => new ActiveMissionProcess(directory, "mission").assertIdle()).toThrow("process group 87654")
    expect(probe).toHaveBeenCalledWith(-87654, 0)
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(87654)
    expect(() => guard.finish()).toThrow("cleanup is incomplete")
    probe.mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    guard.finish()
  })

  it("allows crash recovery only after the recorded worker has exited", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("review")
    guard.spawned(87654)
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    const resumed = new ActiveMissionProcess(directory, "mission")
    resumed.assertIdle()
    expect(probe).toHaveBeenCalledWith(87654, 0)
    expect(readdirSync(directory)).toEqual([])
    resumed.begin("review")
    resumed.finish()
  })

  it("preserves workers that cannot be inspected and malformed markers", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("work")
    guard.spawned(87654)
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
    })
    expect(() => new ActiveMissionProcess(directory, "mission").assertIdle()).toThrow("Cannot inspect")
    expect(readdirSync(directory)).toEqual(["mission.active"])
    writeFileSync(path, "truncated")
    expect(() => guard.assertIdle()).toThrow("Invalid mission process marker")
    expect(readFileSync(path, "utf8")).toBe("truncated")
  })

  it("does not remove another run's replacement marker", () => {
    const first = new ActiveMissionProcess(directory, "mission")
    first.begin("work")
    const firstMarker = readFileSync(path, "utf8")
    rmSync(path)
    const second = new ActiveMissionProcess(directory, "mission")
    second.begin("review")
    first.finish()
    expect(readFileSync(path, "utf8")).not.toBe(firstMarker)
    expect(() => first.spawned(87654)).toThrow("lost its process marker")
    second.finish()
  })

  it("keeps an unknown spawned PID pending and rejects unsafe mission paths", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("work")
    guard.spawned(undefined)
    expect(() => guard.assertIdle()).toThrow("before recording its worker PID")
    expect(() => new ActiveMissionProcess(directory, "../mission")).toThrow("Invalid mission ID")
    guard.finish()
  })
})
