import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MissionApi, type MissionApiDependencies } from "../mission-api"
import { digest, type JobLiveness, MissionJobs } from "../mission-jobs"

let root: string
let workspace: string
let api: MissionApi
let dependencies: MissionApiDependencies
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-control-review-")))
  workspace = join(root, "bound")
  await mkdir(workspace)
  dependencies = {
    launch: vi.fn().mockResolvedValue({ pid: 42, identity: "owned-process" }),
    liveness: vi.fn().mockReturnValue("running"),
    signal: vi.fn(),
    validateOrder: vi.fn().mockResolvedValue({}),
    env: {},
  }
  api = await MissionApi.create(workspace, dependencies)
})
afterEach(async () => {
  await api.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("independent mission control boundary regressions", () => {
  it.each(["directory", "record"])("rejects reads through an out-of-workspace mission %s symlink", async (link) => {
    const outside = join(root, "outside")
    const mission = missionFixture()
    mission.repositoryRoot = outside
    mission.goal = "Private evidence in another repository"
    const outsideRecords = join(outside, ".agent-valley", "missions")
    await new MissionStore(outsideRecords).save(mission)
    const records = join(workspace, ".agent-valley", "missions")
    await mkdir(join(workspace, ".agent-valley"))
    if (link === "directory") await symlink(outsideRecords, records)
    else {
      await mkdir(records)
      await symlink(join(outsideRecords, `${mission.id}.json`), join(records, `${mission.id}.json`))
    }
    await expect(api.status(mission.id)).rejects.toThrow(/symlink|real directory|regular file/)
    await expect(api.report(mission.id)).rejects.toThrow(/symlink|real directory|regular file/)
    await expect(api.list()).rejects.toThrow(/symlink|real directory|regular file/)
    expect(dependencies.launch).not.toHaveBeenCalled()
  })

  it.each(["stopped", "unknown"] as const)(
    "rechecks supervisor identity after storing cancellation when it becomes %s",
    async (afterSave) => {
      const order = await api.order({ goal: "Observe actual evidence", requestId: "identity-race", once: true })
      let liveness: JobLiveness = "running"
      if (!dependencies.liveness) throw new Error("Expected mocked process identity port")
      vi.mocked(dependencies.liveness).mockImplementation(() => liveness)
      const save = MissionJobs.prototype.save
      vi.spyOn(MissionJobs.prototype, "save").mockImplementation(async function (this: MissionJobs, job) {
        await save.call(this, job)
        if (job.cancelRequestedAt) liveness = afterSave
      })
      await api.cancel(String(order.missionId)).catch(() => undefined)
      expect(dependencies.signal).not.toHaveBeenCalled()
      expect(liveness).toBe(afterSave)
    },
  )

  it("retains an uncertain pre-spawn receipt when saving the started receipt fails, so reconnect cannot duplicate work", async () => {
    const save = MissionJobs.prototype.save
    vi.spyOn(MissionJobs.prototype, "save").mockImplementation(async function (this: MissionJobs, job) {
      if (job.phase === "started") throw new Error("Injected disk failure after spawn")
      await save.call(this, job)
    })
    const input = { goal: "Observe actual evidence", requestId: "spawn-receipt-failure", once: true }
    await expect(api.order(input)).rejects.toThrow("disk failure after spawn")
    const receipt = JSON.parse(
      await readFile(join(workspace, ".agent-valley", "control", "jobs", `${digest(input.requestId)}.json`), "utf8"),
    )
    expect(receipt.phase).toBe("prepared")
    await api.close()
    dependencies.liveness = vi.fn().mockReturnValue("unknown")
    api = await MissionApi.create(workspace, dependencies)
    expect(await api.order(input)).toMatchObject({ status: "launch-uncertain", replayed: true })
    expect(dependencies.launch).toHaveBeenCalledTimes(1)
    expect(dependencies.signal).not.toHaveBeenCalled()
    await expect(api.resume({ missionId: receipt.missionId, retry: true, requestId: "unsafe-replay" })).rejects.toThrow(
      "uncertain supervisor",
    )
    await expect(api.cancel(receipt.missionId)).rejects.toThrow("identity")
    expect(dependencies.launch).toHaveBeenCalledTimes(1)
    expect(dependencies.signal).not.toHaveBeenCalled()
  })
})
