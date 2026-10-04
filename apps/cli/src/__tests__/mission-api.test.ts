import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MissionApi, type MissionApiDependencies } from "../mission-api"
import { digest, MissionJobs } from "../mission-jobs"

let root: string
let api: MissionApi
let store: MissionStore
let dependencies: MissionApiDependencies &
  Required<Pick<MissionApiDependencies, "launch" | "liveness" | "signal" | "validateOrder">>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-mission-api-")))
  dependencies = {
    launch: vi.fn().mockResolvedValue({ pid: 42, identity: "owned-process" }),
    liveness: vi.fn().mockReturnValue("running"),
    signal: vi.fn(),
    validateOrder: vi.fn().mockResolvedValue({}),
    env: {},
  }
  api = await MissionApi.create(root, dependencies)
  store = new MissionStore(join(root, ".agent-valley/missions"))
})
afterEach(async () => {
  await api.close()
  await rm(root, { recursive: true, force: true })
})

describe("durable mission API", () => {
  it("binds work to the configured target while retaining project configuration and mission state in their original directory", async () => {
    const target = join(root, "selected-repository")
    await mkdir(target)
    await writeFile(join(root, "av.yaml"), `workspace:\n  root: ${target}\nverify:\n  command: node verify.js\n`)
    await api.close()
    api = await MissionApi.create(root, dependencies)
    expect(api.targetWorkspace).toBe(target)
    const result = await api.order({
      goal: "Fix the selected repository",
      workspace: target,
      requestId: "selected-target",
    })
    expect(dependencies.validateOrder).toHaveBeenCalledWith(root, expect.objectContaining({ workspace: target }))
    expect(dependencies.launch).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: root, args: expect.arrayContaining(["--workspace", target]) }),
    )
    expect(await api.list()).toMatchObject({ project: root, workspace: target })
    const mission = missionFixture()
    mission.id = String(result.missionId)
    mission.repositoryRoot = target
    mission.status = "paused"
    await store.save(mission)
    vi.mocked(dependencies.liveness).mockReturnValue("stopped")
    await api.resume({ missionId: mission.id, retry: true, requestId: "resume-selected-target" })
    expect(vi.mocked(dependencies.launch).mock.calls[1]?.[0].workspace).toBe(root)
    await expect(api.order({ goal: "Wrong repository", workspace: root })).rejects.toThrow("bound")
  })

  it("returns a durable ID before initialization, retains it on retry after reconnection, and never claims completion", async () => {
    const first = await api.order({ goal: "Fix login", requestId: "client-request-1" })
    expect(first).toMatchObject({ accepted: true, status: "starting", replayed: false, supervisor: "running" })
    expect((await api.list()).missions).toEqual([expect.objectContaining({ missionId: first.missionId })])
    await expect(api.report(String(first.missionId))).rejects.toThrow()
    await api.close()
    api = await MissionApi.create(root, dependencies)
    const repeated = await api.order({ goal: "Fix login", requestId: "client-request-1" })
    expect(repeated).toMatchObject({ missionId: first.missionId, replayed: true })
    expect(dependencies.launch).toHaveBeenCalledTimes(1)
    const receipt = JSON.parse(
      await readFile(join(root, ".agent-valley/control/jobs", `${digest("client-request-1")}.json`), "utf8"),
    )
    expect(receipt).toMatchObject({ phase: "started", missionId: first.missionId, pid: 42 })
  })

  it("serializes simultaneous retry requests and rejects reuse with different intent", async () => {
    const input = { goal: "Review usability", requestId: "same-request" }
    const [one, two] = await Promise.all([api.order(input), api.order(input)])
    expect(two.missionId).toBe(one.missionId)
    expect(dependencies.launch).toHaveBeenCalledTimes(1)
    await expect(api.order({ ...input, goal: "Publish campaign" })).rejects.toThrow("different inputs")
  })

  it("bounds caller input and binds tools to one repository before launch", async () => {
    await expect(api.order({ goal: "" })).rejects.toThrow()
    await expect(api.order({ goal: "Test", parallel: 9 })).rejects.toThrow()
    await expect(api.order({ goal: "Test", workspace: tmpdir() })).rejects.toThrow("bound")
    await expect(api.status("../../outside")).rejects.toThrow()
    expect(dependencies.launch).not.toHaveBeenCalled()
  })

  it("passes goals as one positional argument after option termination", async () => {
    const goal = "--actor codex $(never-run) `never-run`"
    await api.order({ goal, requestId: "literal-goal", verify: "node verify.js", parallel: 2, cost: 5 })
    expect(dependencies.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: root,
        args: expect.arrayContaining(["--verify", "node verify.js", "--parallel", "2", "--cost", "5"]),
      }),
    )
    const call = vi.mocked(dependencies.launch).mock.calls[0]?.[0]
    expect(call?.args.slice(-2)).toEqual(["--", goal])
  })

  it("records failed startup without inventing a mission or replaying it", async () => {
    vi.mocked(dependencies.launch).mockRejectedValue(new Error("No executable"))
    await expect(api.order({ goal: "Fix login", requestId: "bad-runtime" })).rejects.toThrow("No executable")
    const repeated = await api.order({ goal: "Fix login", requestId: "bad-runtime" })
    expect(repeated).toMatchObject({ accepted: false, status: "failed-to-start", replayed: true })
    expect(dependencies.launch).toHaveBeenCalledTimes(1)
    expect(await store.list()).toEqual([])
  })

  it("does not replay an uncertain receipt left before process creation", async () => {
    const content = { kind: "order", goal: "Fix login" }
    const jobs = new MissionJobs(root)
    await jobs.locked(() =>
      jobs.save({
        version: 1,
        requestId: "uncertain",
        inputHash: digest(JSON.stringify(content)),
        missionId: "mission-uncertain",
        phase: "prepared",
        kind: "order",
        createdAt: new Date().toISOString(),
      }),
    )
    expect(await api.order({ goal: "Fix login", requestId: "uncertain" })).toMatchObject({
      status: "launch-uncertain",
      replayed: true,
    })
    expect(dependencies.launch).not.toHaveBeenCalled()
  })

  it("reports persisted evidence and cancellation intent separately from completion", async () => {
    const started = await api.order({ goal: "Fix login", requestId: "evidence" })
    const mission = missionFixture()
    mission.id = String(started.missionId)
    mission.repositoryRoot = root
    mission.status = "executing"
    await store.save(mission)
    const status = await api.status(mission.id)
    expect(status).toMatchObject({ status: "executing", verification: mission.verification })
    expect((await api.report(mission.id)).markdown).toContain("executing")
    const cancelled = await api.cancel(mission.id)
    expect(cancelled).toMatchObject({ cancelRequested: true, status: "executing" })
    expect(dependencies.signal).toHaveBeenCalledWith(42)
    expect((await store.load(mission.id)).status).toBe("executing")
    mission.status = "paused"
    mission.error = "Operator stopped supervision"
    await store.save(mission)
    expect(await api.status(mission.id)).toMatchObject({ status: "paused", error: mission.error })
  })

  it("never signals an unknown or reused process identity", async () => {
    const started = await api.order({ goal: "Fix login" })
    vi.mocked(dependencies.liveness).mockReturnValue("unknown")
    await expect(api.cancel(String(started.missionId))).rejects.toThrow("identity")
    vi.mocked(dependencies.liveness).mockReturnValue("stopped")
    expect(await api.cancel(String(started.missionId))).toMatchObject({ cancelRequested: false })
    expect(dependencies.signal).not.toHaveBeenCalled()
  })

  it("requires the existing supervisor to stop before resume and retains the original mission and spend", async () => {
    const started = await api.order({ goal: "Fix login", requestId: "original" })
    const mission = missionFixture()
    mission.id = String(started.missionId)
    mission.repositoryRoot = root
    mission.status = "paused"
    await store.save(mission)
    await expect(api.resume({ missionId: mission.id, retry: true, requestId: "resume-1" })).rejects.toThrow(
      "supervisor",
    )
    vi.mocked(dependencies.liveness).mockReturnValue("stopped")
    expect(await api.resume({ missionId: mission.id, retry: true, requestId: "resume-1", runs: 300 })).toMatchObject({
      accepted: true,
      missionId: mission.id,
    })
    expect(vi.mocked(dependencies.launch).mock.calls[1]?.[0].args).toEqual([
      "order",
      "--runs",
      "300",
      "--resume",
      mission.id,
      "--retry",
    ])
    expect((await store.load(mission.id)).goal).toBe(mission.goal)
    expect((await store.load(mission.id)).verification).toEqual(mission.verification)
    await api.resume({ missionId: mission.id, retry: true, requestId: "resume-1", runs: 300 })
    expect(dependencies.launch).toHaveBeenCalledTimes(2)
  })

  it("blocks recursive delegation from AV-managed Actors", async () => {
    await api.close()
    api = await MissionApi.create(root, { ...dependencies, env: { AGENT_VALLEY_MANAGED_RUN: "1" } })
    await expect(api.order({ goal: "Fix login" })).rejects.toThrow("already managed")
    await expect(api.resume({ missionId: "existing", retry: true })).rejects.toThrow("already managed")
    expect(dependencies.launch).not.toHaveBeenCalled()
  })

  it("rejects a symlink control directory before writing receipts", async () => {
    await symlink(tmpdir(), join(root, ".agent-valley"))
    await expect(api.order({ goal: "Fix login" })).rejects.toThrow("real directory")
    expect(dependencies.launch).not.toHaveBeenCalled()
  })
})
