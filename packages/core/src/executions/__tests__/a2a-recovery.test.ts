import { rm } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reconcileA2aExecution, resumeA2aExecution, startA2aExecution } from "../a2a-service"
import { A2aJobStore } from "../a2a-store"
import { artifactResponse, fixtureEndpoint, fixtureRepository } from "./a2a.fixture"

let root: string
let server: Awaited<ReturnType<typeof fixtureEndpoint>> | undefined
beforeEach(async () => {
  root = await fixtureRepository()
  vi.stubEnv("AV_A2A_RECOVERY_TEST_TOKEN", undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})

describe("A2A repository recovery barriers", () => {
  it("does not resume another saved execution while a later submission remains uncertain", async () => {
    let firstId = ""
    let uncertainId = ""
    server = await fixtureEndpoint(root, async (rpc, _job, response) => {
      const message = rpc.params.message as { metadata: { agentValley: { attemptId: string } } }
      const id = message.metadata.agentValley.attemptId
      if (id === uncertainId) {
        response.destroy()
        return {}
      }
      return { task: artifactResponse(await new A2aJobStore(root).load(id)) }
    })
    const options = {
      root,
      goal: "Write answer 42",
      endpoint: server.endpoint,
      allowedPaths: ["result.txt"],
      verifyCommand: "node verify.cjs",
      timeoutSec: 5,
    }
    await expect(
      startA2aExecution(
        { ...options, endpoint: { ...server.endpoint, authTokenEnv: "AV_A2A_RECOVERY_TEST_TOKEN" } },
        undefined,
        (job) => {
          firstId = job.id
        },
      ),
    ).rejects.toThrow("AV_A2A_RECOVERY_TEST_TOKEN")
    await expect(
      startA2aExecution(options, undefined, (job) => {
        uncertainId = job.id
      }),
    ).rejects.toThrow("unknown")
    vi.stubEnv("AV_A2A_RECOVERY_TEST_TOKEN", "fixture-token")
    await expect(resumeA2aExecution(root, firstId)).rejects.toThrow("unresolved")
    expect(server.requests.map((request) => request.method)).toEqual(["SendMessage"])
    expect(await server.bytes()).toBe("0\n")
    expect((await new A2aJobStore(root).load(uncertainId)).status).toBe("unknown")
    await reconcileA2aExecution(root, uncertainId, "Operator confirmed that the remote execution stopped.")
    expect((await resumeA2aExecution(root, firstId)).status).toBe("completed")
    expect(server.requests.map((request) => request.method)).toEqual(["SendMessage", "SendMessage"])
  })
})
