import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as atomicJson from "../util/atomic-json"
import { ActiveMissionProcess } from "./active-process"

let directory: string
let path: string
const childPid = 87654

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "chief-registration-"))
  path = join(directory, "mission.active")
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe("process registration cleanup evidence", () => {
  it("retains the spawn barrier until an unsuccessfully recorded process group is proven gone", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("verify")
    const write = vi.spyOn(atomicJson, "writeJsonAtomicSync").mockImplementation(() => {
      throw new Error("Disk unavailable")
    })
    expect(() => guard.spawned(childPid, true)).toThrow("Disk unavailable")
    write.mockRestore()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: null })
    const probe = vi.spyOn(process, "kill").mockReturnValue(true)
    expect(() => guard.finish()).toThrow("cleanup is incomplete")
    expect(probe).toHaveBeenCalledWith(-childPid, 0)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: null })
    probe.mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    expect(() => guard.finish()).not.toThrow()
    expect(() => readFileSync(path)).toThrow()
  })

  it("keeps remembered ownership when the process marker disappears before registration", () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("verify")
    rmSync(path)
    expect(() => guard.spawned(childPid, true)).toThrow("lost its process marker")
    const probe = vi.spyOn(process, "kill").mockReturnValue(true)
    expect(() => guard.finish()).toThrow("cleanup is incomplete")
    expect(() => guard.begin("another-run")).toThrow("cleanup is incomplete")
    expect(probe).toHaveBeenCalledWith(-childPid, 0)
    probe.mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    guard.finish()
    expect(() => guard.begin("another-run")).not.toThrow()
    guard.finish()
  })

  it("does not clear another owner's replacement marker while reconciling a remembered child", () => {
    const first = new ActiveMissionProcess(directory, "mission")
    first.begin("verify")
    rmSync(path)
    const second = new ActiveMissionProcess(directory, "mission")
    second.begin("review")
    const replacement = readFileSync(path, "utf8")
    expect(() => first.spawned(childPid, true)).toThrow("lost its process marker")
    const probe = vi.spyOn(process, "kill").mockReturnValue(true)
    expect(() => first.finish()).toThrow("cleanup is incomplete")
    expect(readFileSync(path, "utf8")).toBe(replacement)
    probe.mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    first.finish()
    expect(readFileSync(path, "utf8")).toBe(replacement)
    second.finish()
  })

  it("retains an uninspectable remembered group and keeps a crash-reloaded null marker unresolved", async () => {
    const guard = new ActiveMissionProcess(directory, "mission")
    guard.begin("verify")
    const write = vi.spyOn(atomicJson, "writeJsonAtomicSync").mockImplementation(() => {
      throw new Error("Disk unavailable")
    })
    expect(() => guard.spawned(childPid, true)).toThrow()
    write.mockRestore()
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Denied"), { code: "EPERM" })
    })
    expect(() => guard.finish()).toThrow("Cannot inspect")
    const reloaded = new ActiveMissionProcess(directory, "mission")
    expect(() => reloaded.assertIdle()).toThrow("before recording its Actor PID")
    await expect(reloaded.recoverOrphan()).rejects.toThrow()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: null })
  })
})
