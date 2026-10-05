import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OperationApi } from "../operation-api"

describe("asynchronous operation API", () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "av-operation-api-")))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  function fixture() {
    const launch = vi.fn().mockResolvedValue({ pid: 12345, identity: "fake-process" })
    const validateOrder = vi.fn().mockResolvedValue({})
    const signal = vi.fn()
    const liveness = vi.fn().mockReturnValue("running")
    const api = new OperationApi(root, root, { launch, validateOrder, signal, liveness, env: {} })
    return { api, launch, validateOrder, signal, liveness }
  }
  it("starts detached, retains request identity and separates operation jobs from ordinary missions", async () => {
    const { api, launch, validateOrder } = fixture()
    const input = { charter: "--Improve the service", requestId: "first", cycles: 2, interval: 60, runs: 100 }
    const first = await api.operate(input)
    expect(first).toMatchObject({ accepted: true, status: "starting", replayed: false })
    expect(launch.mock.calls[0]?.[0].args).toEqual([
      "order",
      "--operation-id",
      first.operationId,
      "--workspace",
      root,
      "--cycles",
      "2",
      "--interval",
      "60",
      "--runs",
      "100",
      "--",
      "--Improve the service",
    ])
    expect(validateOrder).toHaveBeenCalledWith(root, { workspace: root, verify: undefined, runs: "100" })
    expect(await api.operate(input)).toMatchObject({ operationId: first.operationId, replayed: true })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0].logPath).toContain("operation-jobs")
    expect((await api.list()).operations).toHaveLength(1)
    await expect(api.operate({ ...input, charter: "different" })).rejects.toThrow("different operation inputs")
    await api.close()
    await expect(api.status(String(first.operationId))).rejects.toThrow("closed")
  })
  it("signals only a verified supervisor and exposes asynchronous cancellation", async () => {
    const { api, signal, liveness } = fixture()
    const operation = await api.operate({ charter: "Improve onboarding" })
    const id = String(operation.operationId)
    liveness.mockReturnValue("unknown")
    await expect(api.cancel(id)).rejects.toThrow("identity is uncertain")
    expect(signal).not.toHaveBeenCalled()
    liveness.mockReturnValue("running")
    expect(await api.cancel(id)).toMatchObject({ cancelRequested: true })
    expect(signal).toHaveBeenCalledWith(12345)
  })
  it("uses order as the continuous entry and refuses single-goal mode rather than ignoring it", async () => {
    const { api, launch } = fixture()
    const first = await api.order({ goal: "Improve conversion", requestId: "unified-order", cycles: 2 })
    expect(first).toMatchObject({ operationId: expect.any(String), accepted: true })
    expect(launch.mock.calls[0]?.[0].args[0]).toBe("order")
    expect(() => api.order({ goal: "One goal", once: true })).toThrow("once:true")
    expect(launch).toHaveBeenCalledTimes(1)
  })
  it("resumes original saved state and refuses uncertain live owners", async () => {
    const { api, launch, liveness } = fixture()
    const first = await api.operate({ charter: "Improve maintainability" })
    const id = String(first.operationId)
    const now = new Date().toISOString()
    await new ContinuousOperationStore(join(root, ".agent-valley/operations")).save({
      id,
      repositoryRoot: root,
      charter: "Improve maintainability",
      settings: { actor: "codex", model: "pinned-model" },
      phase: "paused",
      createdAt: now,
      updatedAt: now,
      completedCycles: 1,
      cycleLimit: 2,
      waitIntervalSec: 60,
      history: [],
    })
    await expect(api.resume({ operationId: id })).rejects.toThrow("active or uncertain")
    liveness.mockReturnValue("stopped")
    expect(await api.resume({ operationId: id, requestId: "resume" })).toMatchObject({
      accepted: true,
      operationId: id,
    })
    expect(launch.mock.calls[1]?.[0].args).toEqual(["order", "--resume", id])
    expect(await api.report(id)).toMatchObject({ markdown: expect.stringContaining("Improve maintainability") })
  })
  it("rejects recursive operations and invalid inputs before dispatch", async () => {
    const launch = vi.fn()
    const api = new OperationApi(root, root, { launch, env: { AGENT_VALLEY_MANAGED_RUN: "1" } })
    expect(() => api.operate({ charter: "Nested" })).toThrow("managed")
    expect(() => api.resume({ operationId: "example" })).toThrow("managed")
    const { api: normal } = fixture()
    expect(() => normal.operate({ charter: "Goal", cycles: 0 })).toThrow()
    await expect(normal.status("../escape")).rejects.toThrow()
    expect(launch).not.toHaveBeenCalled()
  })
  it("does not automatically retry an uncertain failed launch", async () => {
    const { api, launch } = fixture()
    launch.mockRejectedValue(new Error("fake launch failure"))
    const input = { charter: "Improve service", requestId: "failed-launch" }
    await expect(api.operate(input)).rejects.toThrow("could not be confirmed")
    expect(await api.operate(input)).toMatchObject({ accepted: false, replayed: true })
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
