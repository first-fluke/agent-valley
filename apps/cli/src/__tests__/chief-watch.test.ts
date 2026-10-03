import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema, MissionPause, recordPause } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerChiefCommands } from "../chief"
import { abortableDelay, superviseOrder } from "../chief-supervisor"

vi.mock("../chief-supervisor", () => ({ superviseOrder: vi.fn(), abortableDelay: vi.fn() }))

let root: string | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("Chief mission watcher cancellation", () => {
  it("stops after the active mission and leaves later due missions unchanged", async () => {
    root = await mkdtemp(join(tmpdir(), "av-chief-watch-"))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const first = missionFixture()
    first.id = "a-active"
    first.status = "executing"
    first.executionPolicy = executionPolicySchema.parse({})
    const second = structuredClone(first)
    second.id = "b-next"
    await store.save(first)
    await store.save(second)
    const secondPath = join(root, ".agent-valley", "missions", `${second.id}.json`)
    const unchanged = await readFile(secondPath, "utf8")
    vi.spyOn(process, "cwd").mockReturnValue(root)
    let stop: (() => void) | undefined
    const emitter: NodeJS.EventEmitter = process
    const originalOnce = emitter.once.bind(emitter)
    vi.spyOn(emitter, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        stop = listener
        return process
      }
      if (event === "SIGTERM") return process
      return originalOnce(event, listener)
    })
    vi.mocked(superviseOrder).mockImplementation(async (_goal, options, _root, dependencies) => {
      expect(options.resume).toBe(first.id)
      if (!stop) throw new Error("Expected watcher cancellation handler")
      stop()
      expect(dependencies?.signal?.aborted).toBe(true)
      const current = await store.load(first.id)
      recordPause(current, new MissionPause("Operator stopped supervision.", "interrupted"))
      await store.save(current)
      return current
    })
    vi.mocked(abortableDelay).mockImplementation(async (_milliseconds, signal) => {
      expect(signal?.aborted).toBe(true)
      throw new Error("Order supervision interrupted.")
    })
    const program = new Command()
    registerChiefCommands(program)
    await expect(program.parseAsync(["missions", "--watch"], { from: "user" })).resolves.toBe(program)
    expect(superviseOrder).toHaveBeenCalledTimes(1)
    expect((await store.load(first.id)).status).toBe("paused")
    expect(await readFile(secondPath, "utf8")).toBe(unchanged)
    expect((await store.load(second.id)).status).toBe("executing")
  })
})
