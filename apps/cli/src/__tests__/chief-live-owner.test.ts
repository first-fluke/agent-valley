import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { superviseOrder } from "../chief-supervisor"
import { watchOrders } from "../chief-watch"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-live-owner-")))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function checkpoint() {
  const mission = missionFixture()
  mission.status = "executing"
  mission.executionPolicy = executionPolicySchema.parse({})
  mission.execution = { startedAt: new Date().toISOString(), runsStarted: 4, retries: 1 }
  return mission
}

describe("live Mission owner protection", () => {
  it("observes missing and proven-dead locks without mutation and protects malformed ownership", async () => {
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = checkpoint()
    await store.save(mission)
    const path = join(root, ".agent-valley", "missions", `${mission.id}.json.lock`)
    expect(await store.isLocked(mission.id)).toBe(false)
    const content = JSON.stringify({ pid: 2147483646, token: randomUUID() })
    await writeFile(path, content)
    const kill = process.kill.bind(process)
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0)
      if (pid === 2147483646) throw Object.assign(new Error("absent"), { code: "ESRCH" })
      return kill(pid, signal)
    })
    expect(await store.isLocked(mission.id)).toBe(false)
    expect(await readFile(path, "utf8")).toBe(content)
    const unlock = await store.lock(mission.id)
    expect(await store.isLocked(mission.id)).toBe(true)
    await unlock()
    await writeFile(path, "invalid owner record")
    expect(await store.isLocked(mission.id)).toBe(true)
    expect(await readFile(path, "utf8")).toBe("invalid owner record")
  })

  it("does not dispatch or change a Mission held by another live owner", async () => {
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = checkpoint()
    await store.save(mission)
    const path = join(root, ".agent-valley", "missions", `${mission.id}.json`)
    const original = await readFile(path, "utf8")
    const unlock = await store.lock(mission.id)
    try {
      const controller = new AbortController()
      const dispatch = vi.fn<typeof superviseOrder>().mockImplementation(async () => {
        controller.abort()
        return mission
      })
      await watchOrders(root, {
        signal: controller.signal,
        mission: dispatch,
        delay: async () => {
          controller.abort()
        },
      })
      expect(dispatch).not.toHaveBeenCalled()
      expect(await readFile(path, "utf8")).toBe(original)
    } finally {
      await unlock()
    }
  })

  it("observes a competing worker lock without recording a crash or pausing its live Mission", async () => {
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = checkpoint()
    await store.save(mission)
    const path = join(root, ".agent-valley", "missions", `${mission.id}.json`)
    const original = await readFile(path, "utf8")
    const controller = new AbortController()
    let unlock: (() => Promise<void>) | undefined
    const worker = vi.fn().mockImplementation(async () => {
      unlock = await store.lock(mission.id)
      return 1
    })
    try {
      await expect(
        superviseOrder(undefined, { resume: mission.id }, root, {
          signal: controller.signal,
          runWorker: worker,
          delay: async () => {
            controller.abort()
          },
        }),
      ).resolves.toMatchObject({ status: "executing" })
      expect(worker).toHaveBeenCalledOnce()
      expect(await readFile(path, "utf8")).toBe(original)
    } finally {
      await unlock?.()
    }
  })
})
