import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchOrder, registerChiefCommands } from "../chief"
import { operationStore } from "../chief-continuous"
import { orderWorkerArgs } from "../chief-supervisor"

let root: string
let repository: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-order-dispatch-")))
  repository = join(root, "target-repository")
  await mkdir(repository)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function operation(id = "continuous-order"): ContinuousOperation {
  const now = new Date().toISOString()
  return {
    id,
    repositoryRoot: repository,
    charter: "Improve service and revenue",
    settings: { workspace: repository, actor: "codex", model: "chosen-model" },
    phase: "paused",
    createdAt: now,
    updatedAt: now,
    completedCycles: 2,
    waitIntervalSec: 300,
    history: [],
  }
}
function runners() {
  const mission = missionFixture()
  mission.repositoryRoot = repository
  const current = operation()
  return {
    mission,
    current,
    continuous: vi.fn(async () => current),
    single: vi.fn(async () => mission),
    supervised: vi.fn(async () => mission),
  }
}

describe("one public order command", () => {
  it("continues by default and keeps explicit Chief identity and canonical legacy options", async () => {
    const dependencies = runners()
    expect(
      await dispatchOrder(
        "Improve the service",
        {
          workspace: repository,
          agent: "codex",
          model: "chosen-model",
          chief: "lead",
          personas: "actors.yaml",
          cycles: "2",
          supervise: true,
        },
        root,
        dependencies,
      ),
    ).toBe(dependencies.current)
    expect(dependencies.continuous).toHaveBeenCalledWith(
      "Improve the service",
      {
        workspace: repository,
        actor: "codex",
        model: "chosen-model",
        director: "lead",
        actors: "actors.yaml",
        cycles: "2",
      },
      root,
    )
    expect(dependencies.single).not.toHaveBeenCalled()
    expect(dependencies.supervised).not.toHaveBeenCalled()
  })

  it("uses --once for one supervised goal and --no-supervise for an explicit direct goal", async () => {
    const dependencies = runners()
    await dispatchOrder("Fix login", { once: true, workspace: repository }, root, dependencies)
    expect(dependencies.supervised).toHaveBeenCalledWith("Fix login", { workspace: repository }, root)
    await dispatchOrder("Fix login", { once: true, supervise: false }, root, dependencies)
    expect(dependencies.single).toHaveBeenCalledWith("Fix login", { supervise: false }, root)
    expect(dependencies.continuous).not.toHaveBeenCalled()
    await expect(dispatchOrder("Goal", { once: true, cycles: "2" }, root, dependencies)).rejects.toThrow("--cycles")
    await expect(dispatchOrder("Goal", { supervise: false }, root, dependencies)).rejects.toThrow("Add --once")
  })

  it("resumes a saved mission from the configuration project without rerouting it into a continuing order", async () => {
    const dependencies = runners()
    dependencies.mission.status = "paused"
    await new MissionStore(join(root, ".agent-valley", "missions")).save(dependencies.mission)
    await dispatchOrder(
      undefined,
      { resume: dependencies.mission.id, retry: true, runs: "250", supervise: true },
      root,
      dependencies,
    )
    expect(dependencies.supervised).toHaveBeenCalledWith(
      undefined,
      { resume: dependencies.mission.id, retry: true, runs: "250", supervise: true },
      root,
    )
    expect(dependencies.mission.repositoryRoot).toBe(repository)
    expect(dependencies.continuous).not.toHaveBeenCalled()
  })

  it("resumes the saved operation kind and preserves its original settings and completed count", async () => {
    const dependencies = runners()
    await operationStore(root).save(dependencies.current)
    await dispatchOrder(
      undefined,
      { resume: dependencies.current.id, cycles: "3", supervise: true },
      root,
      dependencies,
    )
    expect(dependencies.continuous).toHaveBeenCalledWith(
      undefined,
      { resume: dependencies.current.id, cycles: "3" },
      root,
    )
    expect(dependencies.current.completedCycles).toBe(2)
    expect(dependencies.current.settings).toEqual({ workspace: repository, actor: "codex", model: "chosen-model" })
    expect(dependencies.supervised).not.toHaveBeenCalled()
  })

  it("fails closed on missing, ambiguous or corrupted resume records before launching an Actor", async () => {
    const dependencies = runners()
    await expect(dispatchOrder(undefined, { resume: "missing" }, root, dependencies)).rejects.toThrow("No saved order")
    const shared = operation(dependencies.mission.id)
    await operationStore(root).save(shared)
    await new MissionStore(join(root, ".agent-valley", "missions")).save(dependencies.mission)
    await expect(dispatchOrder(undefined, { resume: shared.id }, root, dependencies)).rejects.toThrow(
      "both an operation and a mission",
    )
    await dispatchOrder(undefined, { resume: shared.id, once: true }, root, dependencies)
    expect(dependencies.supervised).toHaveBeenCalledOnce()
    await writeFile(join(root, ".agent-valley", "operations", `${shared.id}.json`), "corrupted")
    await expect(dispatchOrder(undefined, { resume: shared.id }, root, dependencies)).rejects.toThrow()
    expect(dependencies.continuous).not.toHaveBeenCalled()
    expect(dependencies.supervised).toHaveBeenCalledOnce()
    expect(dependencies.single).not.toHaveBeenCalled()
  })

  it("keeps legacy internal workers single and makes every new worker launch explicit --once", async () => {
    const dependencies = runners()
    await dispatchOrder("Child goal", { worker: true, missionId: "child-one" }, root, dependencies)
    expect(dependencies.single).toHaveBeenCalledWith("Child goal", { worker: true, missionId: "child-one" }, root)
    expect(dependencies.continuous).not.toHaveBeenCalled()
    const args = orderWorkerArgs("Child goal", { once: true, missionId: "child-one" }, "child-one")
    expect(args.slice(0, 3)).toEqual(["order", "--once", "--worker"])
    expect(args.filter((argument) => argument === "--once")).toHaveLength(1)
    expect(orderWorkerArgs(undefined, { resume: "child-one" }, "child-one")).toEqual([
      "order",
      "--once",
      "--worker",
      "--resume",
      "child-one",
    ])
  })

  it("shows one public execution command and retains the deprecated operate parser", () => {
    const program = new Command()
    registerChiefCommands(program)
    expect(program.helpInformation()).toContain("order")
    expect(program.helpInformation()).not.toContain("operate")
    const command = program.commands.find((entry) => entry.name() === "order")
    expect(command?.helpInformation()).toContain("--once")
    expect(command?.helpInformation()).toContain("--cycles <count>")
    expect(command?.helpInformation()).toContain("--interval <seconds>")
    expect(program.commands.some((entry) => entry.name() === "operate")).toBe(true)
  })
})
