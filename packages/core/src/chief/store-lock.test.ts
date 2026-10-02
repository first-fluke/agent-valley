import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MissionStore } from "./store"

let directory: string
const stalePid = 987654

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chief-lock-"))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe("mission lock recovery", () => {
  it("allows only one concurrent resume to replace a stale owner", async () => {
    const path = join(directory, "mission.json.lock")
    await writeFile(path, JSON.stringify({ pid: stalePid, token: "dead-owner" }))
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === stalePid) throw Object.assign(new Error("Gone"), { code: "ESRCH" })
      return true
    })

    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => new MissionStore(directory).lock("mission")),
    )
    const owners = results.filter((result) => result.status === "fulfilled")
    expect(owners).toHaveLength(1)
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid)
    await expect(new MissionStore(directory).lock("mission")).rejects.toThrow("already running")
    for (const owner of owners) await owner.value()
    expect(await readdir(directory)).toEqual([])
  })

  it("retains the original lock while another recovery holds its guard", async () => {
    const path = join(directory, "mission.json.lock")
    const original = JSON.stringify({ pid: stalePid, token: "dead-owner" })
    await writeFile(path, original)
    await writeFile(`${path}.reclaim`, JSON.stringify({ pid: process.pid }))
    const probe = vi.spyOn(process, "kill")

    await expect(new MissionStore(directory).lock("mission")).rejects.toThrow("lock recovery is already in progress")
    expect(probe).not.toHaveBeenCalled()
    expect(await readFile(path, "utf8")).toBe(original)
    expect(await readdir(directory)).toHaveLength(2)
  })

  it("preserves a lock when its process cannot be inspected", async () => {
    const path = join(directory, "mission.json.lock")
    const original = JSON.stringify({ pid: stalePid, token: "unknown-owner" })
    await writeFile(path, original)
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Permission denied"), { code: "EPERM" })
    })

    await expect(new MissionStore(directory).lock("mission")).rejects.toThrow("Permission denied")
    expect(await readFile(path, "utf8")).toBe(original)
    expect(await readdir(directory)).toEqual(["mission.json.lock"])
  })
})
