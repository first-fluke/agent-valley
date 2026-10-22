import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ActiveMissionProcess } from "../../chief/active-process"
import { startA2aExecution } from "../a2a-service"
import { artifactResponse, fixtureEndpoint, fixtureRepository } from "./a2a.fixture"

let root: string | undefined
let server: Awaited<ReturnType<typeof fixtureEndpoint>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("A2A verifier termination evidence", () => {
  it("retains unknown and blocks another submission when verifier cleanup cannot be confirmed", async () => {
    root = await fixtureRepository()
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    vi.spyOn(ActiveMissionProcess.prototype, "finish").mockImplementation(() => {
      throw new Error("Verifier process group is still active")
    })
    const options = {
      root,
      goal: "Write answer 42",
      endpoint: server.endpoint,
      allowedPaths: ["result.txt"],
      verifyCommand: "node verify.cjs",
      timeoutSec: 30,
    }
    await expect(startA2aExecution(options)).rejects.toThrow("unknown")
    const saved = await server.saved()
    expect(saved.status).toBe("unknown")
    expect(saved.result).toBeUndefined()
    expect(saved.artifact?.phase).toBe("applied")
    expect(await readdir(join(root, ".agent-valley/a2a"))).toContain(`${saved.id}.active`)
    await expect(startA2aExecution(options)).rejects.toThrow("unresolved")
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage"])
  })
})
