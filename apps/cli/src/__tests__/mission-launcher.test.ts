import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProcessAlive, processIdentity } from "@agent-valley/core/chief/process-identity"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MissionApi } from "../mission-api"
import { MissionJobs } from "../mission-jobs"
import { launchMission } from "../mission-launcher"

let root: string | undefined
let owned: { pid: number; identity?: string } | undefined
afterEach(async () => {
  const child = owned
  if (child?.identity && processIdentity(child.pid) === child.identity) process.kill(child.pid, "SIGTERM")
  if (child) await vi.waitFor(() => expect(isProcessAlive(child.pid)).toBe(false), { timeout: 5_000 })
  if (root) await rm(root, { recursive: true, force: true })
  owned = undefined
})

describe("detached AV supervisor launch", () => {
  it("survives API disconnect, keeps stdout in its private log, and can be cancelled after reconnect", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "av-detached-launch-")))
    const entry = join(root, "fake-cli.mjs")
    await writeFile(
      entry,
      [
        'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n")',
        'process.stderr.write("fake supervisor ready\\n")',
        'process.on("SIGTERM", () => process.exit(0))',
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    const api = await MissionApi.create(root, {
      env: {},
      validateOrder: async () => ({}),
      launch: async (input) => {
        const previous = process.argv[1]
        process.argv[1] = entry
        try {
          owned = await launchMission(input)
          return owned
        } finally {
          if (previous === undefined) process.argv.splice(1, 1)
          else process.argv[1] = previous
        }
      },
    })
    const started = await api.order({ goal: "Literal $(unused) goal", requestId: "fake-launch" })
    await api.close()
    const child = owned
    if (!child?.identity) throw new Error("Expected owned process identity")
    expect(isProcessAlive(child.pid)).toBe(true)
    const jobs = new MissionJobs(root)
    const job = await jobs.findRequest("fake-launch")
    if (!job) throw new Error("Expected launch receipt")
    await vi.waitFor(async () => {
      const log = await readFile(jobs.logPath(job), "utf8")
      expect(log).toContain("fake supervisor ready")
      expect(log).toContain("Literal $(unused) goal")
    })
    const reconnected = await MissionApi.create(root, { env: {} })
    expect(await reconnected.status(String(started.missionId))).toMatchObject({
      supervisor: "running",
      status: "starting",
    })
    expect(await reconnected.cancel(String(started.missionId))).toMatchObject({ cancelRequested: true })
    await vi.waitFor(() => expect(isProcessAlive(child.pid)).toBe(false), { timeout: 5_000 })
    expect(await reconnected.status(String(started.missionId))).toMatchObject({
      supervisor: "stopped",
      status: "failed-to-start",
    })
    await reconnected.close()
  })
})
