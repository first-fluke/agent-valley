import { readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { a2aRequestSha256 } from "../../sessions/adapters/a2a-contracts"
import { a2aJobInput } from "../a2a-job"
import { listA2aExecutions, reconcileA2aExecution, resumeA2aExecution, startA2aExecution } from "../a2a-service"
import { A2aJobStore } from "../a2a-store"
import { artifactResponse, fixtureEndpoint, fixtureRepository } from "./a2a.fixture"

let root: string
let server: Awaited<ReturnType<typeof fixtureEndpoint>> | undefined
beforeEach(async () => {
  root = await fixtureRepository()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
  delete process.env.A2A_VERIFY_FAIL
  await rm(root, { recursive: true, force: true })
})

function start(onCreated?: Parameters<typeof startA2aExecution>[2]) {
  if (!server) throw new Error("Start fixture endpoint first")
  return startA2aExecution(
    {
      root,
      goal: "Write the answer 42",
      endpoint: server.endpoint,
      allowedPaths: ["result.txt"],
      verifyCommand: "node verify.cjs",
      timeoutSec: 30,
    },
    undefined,
    onCreated,
  )
}

describe("durable A2A execution service", () => {
  it("saves submission binding before network, accepts only bound bytes, then runs the fixed verifier", async () => {
    server = await fixtureEndpoint(root, (rpc, job) => {
      expect(job.status).toBe("running")
      expect(job.checkpoint?.phase).toBe("submitting")
      const message = rpc.params.message as { metadata: { agentValley: { attemptId: string; requestSha256: string } } }
      expect(message.metadata.agentValley).toEqual({ attemptId: job.id, requestSha256: job.requestSha256 })
      return { task: artifactResponse(job) }
    })
    let created = ""
    const job = await start((value) => {
      created = value.id
    })
    expect(created).toBe(job.id)
    expect(job.status).toBe("completed")
    expect(job.artifact?.phase).toBe("applied")
    expect(job.verification?.ok).toBe(true)
    expect(job.requestSha256).toBe(a2aRequestSha256(a2aJobInput(job), job.endpoint))
    expect(await server.bytes()).toBe("42\n")
    expect(await resumeA2aExecution(root, job.id)).toMatchObject({ status: "completed" })
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage"])
    expect((await listA2aExecutions(root))[0]?.result?.exitCode).toBe(0)
  })

  it("never repeats a submission whose accepted response was lost", async () => {
    server = await fixtureEndpoint(root, (_rpc, _job, response) => {
      response.destroy()
      return {}
    })
    await expect(start()).rejects.toThrow("unknown")
    const saved = await server.saved()
    expect(saved.checkpoint).toMatchObject({ phase: "unknown" })
    expect(saved.checkpoint?.taskId).toBeUndefined()
    await expect(start()).rejects.toThrow("unresolved")
    await expect(resumeA2aExecution(root, saved.id)).rejects.toThrow("will not be repeated")
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage"])
    expect(await server.bytes()).toBe("0\n")
    const reconciled = await reconcileA2aExecution(
      root,
      saved.id,
      "Operator checked the endpoint: the execution is stopped.",
    )
    expect(reconciled.status).toBe("reconciled")
    expect(reconciled.verification).toBeUndefined()
    expect(reconciled.result).toBeUndefined()
    expect(reconciled.checkpoint?.phase).toBe("unknown")
    await expect(reconcileA2aExecution(root, saved.id, "again")).rejects.toThrow("uncertain")
  })

  it("reconnects a durable remote task using GetTask after transport loss", async () => {
    let broken = true
    server = await fixtureEndpoint(root, (rpc, job, response) => {
      if (rpc.method === "SendMessage")
        return { task: { id: "remote-task", contextId: "remote-context", status: { state: "TASK_STATE_WORKING" } } }
      if (broken) {
        response.destroy()
        return {}
      }
      return artifactResponse(job)
    })
    await expect(start()).rejects.toThrow("unknown")
    const saved = await server.saved()
    expect(saved.checkpoint).toMatchObject({ taskId: "remote-task", phase: "unknown" })
    broken = false
    const resumed = await resumeA2aExecution(root, saved.id)
    expect(resumed.status).toBe("completed")
    expect(resumed.verification?.ok).toBe(true)
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage", "GetTask", "GetTask"])
  })

  it("retains failed verification and rechecks the saved artifact without another remote request", async () => {
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    process.env.A2A_VERIFY_FAIL = "1"
    await expect(start()).rejects.toThrow("trusted verification")
    const saved = await server.saved()
    expect(saved.status).toBe("failed")
    expect(saved.verification?.ok).toBe(false)
    expect(saved.response?.task?.id).toBe("remote-task")
    delete process.env.A2A_VERIFY_FAIL
    const resumed = await resumeA2aExecution(root, saved.id)
    expect(resumed.status).toBe("completed")
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage"])
  })

  it("rejects repository drift before changing a returned file", async () => {
    server = await fixtureEndpoint(root, async (_rpc, job) => {
      await writeFile(join(root, "result.txt"), "operator change\n")
      return { task: artifactResponse(job) }
    })
    await expect(start()).rejects.toThrow("failed")
    expect(await server.bytes()).toBe("operator change\n")
    expect((await server.saved()).verification).toBeUndefined()
  })

  it("applies no fresh files when interrupted while saving the terminal response", async () => {
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    const controller = new AbortController()
    const originalSave = A2aJobStore.prototype.save
    const save = vi.spyOn(A2aJobStore.prototype, "save").mockImplementation(async function (this: A2aJobStore, job) {
      await originalSave.call(this, job)
      if (job.response && !job.artifact) controller.abort(new Error("Operator interrupted after terminal receipt"))
    })
    await expect(
      startA2aExecution(
        {
          root,
          goal: "Write answer 42",
          endpoint: server.endpoint,
          allowedPaths: ["result.txt"],
          verifyCommand: "node verify.cjs",
          timeoutSec: 30,
        },
        controller.signal,
      ),
    ).rejects.toThrow()
    save.mockRestore()
    expect(await server.bytes()).toBe("0\n")
    const saved = await server.saved()
    expect(saved.artifact).toBeUndefined()
    expect(saved.response?.task?.id).toBe("remote-task")
    expect((await resumeA2aExecution(root, saved.id)).status).toBe("completed")
    expect(server.requests.map((entry) => entry.method)).toEqual(["SendMessage"])
  })

  it("rejects a verifier that changes the delivered file even when its command exits successfully", async () => {
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    await expect(
      startA2aExecution({
        root,
        goal: "Write answer 42",
        endpoint: server.endpoint,
        allowedPaths: ["result.txt"],
        verifyCommand: `node -e "require('node:fs').writeFileSync('result.txt','mutated')"`,
        timeoutSec: 30,
      }),
    ).rejects.toThrow("trusted verification")
    const saved = await server.saved()
    expect(saved.status).toBe("failed")
    expect(saved.verification?.ok).toBe(false)
    expect(saved.result).toBeUndefined()
  })

  it("refuses dirty repositories, unsafe endpoint secrets and forbidden paths before submitting", async () => {
    server = await fixtureEndpoint(root, (_rpc, job) => ({ task: artifactResponse(job) }))
    await writeFile(join(root, "result.txt"), "dirty")
    await expect(start()).rejects.toThrow("clean repository")
    await writeFile(join(root, "result.txt"), "0\n")
    await expect(
      startA2aExecution({
        root,
        goal: "x",
        endpoint: { ...server.endpoint, url: "https://user:secret@example.invalid/rpc" },
        allowedPaths: ["result.txt"],
        verifyCommand: "node verify.cjs",
      }),
    ).rejects.toThrow()
    await expect(
      startA2aExecution({
        root,
        goal: "x",
        endpoint: server.endpoint,
        allowedPaths: ["../outside"],
        verifyCommand: "node verify.cjs",
      }),
    ).rejects.toThrow()
    expect(server.requests).toHaveLength(0)
    expect(await listA2aExecutions(root)).toEqual([])
  })

  it("serializes repository writers and refuses a modified saved request", async () => {
    server = await fixtureEndpoint(root, (_rpc, _job, response) => {
      response.destroy()
      return {}
    })
    const store = new A2aJobStore(root)
    const release = await store.lock()
    try {
      await expect(start()).rejects.toThrow("already running")
    } finally {
      await release()
    }
    await expect(start()).rejects.toThrow()
    const saved = await server.saved()
    saved.prompt = "different request"
    await store.save(saved)
    await expect(resumeA2aExecution(root, saved.id)).rejects.toThrow("request binding changed")
    expect(server.requests).toHaveLength(1)
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe("0\n")
  })

  it("rejects storage redirected outside the repository", async () => {
    const other = await fixtureRepository()
    try {
      await symlink(other, join(root, ".agent-valley"))
      await expect(new A2aJobStore(root).lock()).rejects.toThrow("inside its repository")
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
