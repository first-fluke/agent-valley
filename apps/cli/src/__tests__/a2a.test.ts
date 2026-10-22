import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { A2aJob } from "@agent-valley/core/executions/a2a-job"
import {
  listA2aExecutions,
  reconcileA2aExecution,
  resumeA2aExecution,
  startA2aExecution,
} from "@agent-valley/core/executions/a2a-service"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerA2aCommands } from "../a2a"

vi.mock("@agent-valley/core/executions/a2a-service", () => ({
  startA2aExecution: vi.fn(),
  resumeA2aExecution: vi.fn(),
  reconcileA2aExecution: vi.fn(),
  listA2aExecutions: vi.fn(),
}))

let root: string
let endpointFile: string
let previousExitCode: typeof process.exitCode
const id = "d9dd9e4d-9c11-48a4-ae59-97058ab1b86f"
const endpoint = { id: "remote", url: "https://agent.example/rpc", authTokenEnv: "AV_A2A_TOKEN" }

function job(status: A2aJob["status"] = "completed"): A2aJob {
  const now = new Date().toISOString()
  return {
    version: 1,
    id,
    root,
    repositoryId: "1".repeat(64),
    baseRevision: "2".repeat(40),
    baseFingerprint: "3".repeat(64),
    branch: "main",
    endpoint,
    goal: "PRIVATE_GOAL",
    prompt: "PRIVATE_PROMPT",
    requestSha256: "4".repeat(64),
    allowedPaths: ["src/example.ts"],
    verifyCommand: "PRIVATE_VERIFY_COMMAND",
    timeoutSec: 600,
    createdAt: now,
    updatedAt: now,
    status,
    checkpoint: {
      version: 1,
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      attemptId: id,
      messageId: "message-1",
      requestSha256: "4".repeat(64),
      phase: status === "completed" ? "terminal" : "unknown",
      taskId: "remote-task-1",
      contextId: "remote-context-1",
    },
    verification: {
      ok: status === "completed",
      command: "PRIVATE_VERIFY_COMMAND",
      output: "PRIVATE_VERIFICATION_OUTPUT",
      fingerprint: "5".repeat(64),
      at: now,
    },
    error: "PRIVATE_ENDPOINT_ERROR",
    reconciliation: { evidence: "PRIVATE_TERMINATION_EVIDENCE", at: now },
  }
}

function program(): Command {
  const command = new Command().exitOverride().configureOutput({ writeErr: () => {} })
  registerA2aCommands(command, root)
  return command
}

function runArgs(extra: string[] = []): string[] {
  return [
    "a2a",
    "run",
    "Repair the example",
    "--endpoint",
    endpointFile,
    "--allow",
    "src/example.ts",
    "--verify",
    "bun test",
    ...extra,
  ]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-a2a-cli-"))
  endpointFile = join(root, "endpoint.json")
  await writeFile(endpointFile, JSON.stringify(endpoint))
  previousExitCode = process.exitCode
  vi.resetAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(startA2aExecution).mockResolvedValue(job())
  vi.mocked(resumeA2aExecution).mockResolvedValue(job())
  vi.mocked(reconcileA2aExecution).mockResolvedValue(job("reconciled"))
  vi.mocked(listA2aExecutions).mockResolvedValue([job()])
})

afterEach(async () => {
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("A2A CLI run", () => {
  it("passes explicit endpoint, paths and verifier, and prints the durable ID before service completion", async () => {
    vi.stubEnv("AV_A2A_TOKEN", "PRIVATE_TOKEN_VALUE")
    vi.mocked(startA2aExecution).mockImplementation(async (_options, signal, onCreated) => {
      expect(signal?.aborted).toBe(false)
      expect(console.log).not.toHaveBeenCalled()
      onCreated?.(job("pending"))
      expect(console.log).toHaveBeenCalledWith(`A2A execution ${id}`)
      return job()
    })
    await program().parseAsync(runArgs(["--allow", "tests/example.test.ts", "--timeout", "42"]), { from: "user" })
    expect(startA2aExecution).toHaveBeenCalledWith(
      {
        root,
        goal: "Repair the example",
        endpoint,
        allowedPaths: ["src/example.ts", "tests/example.test.ts"],
        verifyCommand: "bun test",
        timeoutSec: 42,
      },
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(process.exitCode).toBe(0)
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("PRIVATE_")
  })

  it("reads one prompt file and accepts an explicit absolute workspace", async () => {
    const promptFile = join(root, "goal.txt")
    await writeFile(promptFile, "  Repair the Korean login labels: 로그인\n")
    await program().parseAsync(
      [
        "a2a",
        "run",
        "--prompt-file",
        promptFile,
        "--endpoint",
        endpointFile,
        "--allow",
        "src/example.ts",
        "--verify",
        "bun test",
        "--workspace",
        root,
      ],
      { from: "user" },
    )
    expect(vi.mocked(startA2aExecution).mock.calls[0]?.[0]).toMatchObject({
      root,
      goal: "Repair the Korean login labels: 로그인",
      timeoutSec: 600,
    })
  })

  it.each([
    ["a2a", "run", "--endpoint", "ENDPOINT", "--allow", "src/example.ts", "--verify", "true"],
    [
      "a2a",
      "run",
      "Goal",
      "--prompt-file",
      "unread.txt",
      "--endpoint",
      "ENDPOINT",
      "--allow",
      "src/example.ts",
      "--verify",
      "true",
    ],
  ])("requires exactly one goal source", async (...args) => {
    await expect(
      program().parseAsync(
        args.map((value) => (value === "ENDPOINT" ? endpointFile : value)),
        { from: "user" },
      ),
    ).rejects.toThrow("exactly one")
    expect(startA2aExecution).not.toHaveBeenCalled()
  })

  it.each(["0", "86401", "1.5", "not-a-number"])("rejects timeout %s before dispatch", async (timeout) => {
    await expect(program().parseAsync(runArgs(["--timeout", timeout]), { from: "user" })).rejects.toThrow("--timeout")
    expect(startA2aExecution).not.toHaveBeenCalled()
  })

  it("requires allowed paths and an absolute workspace", async () => {
    await expect(
      program().parseAsync(["a2a", "run", "Goal", "--endpoint", endpointFile, "--verify", "true"], { from: "user" }),
    ).rejects.toThrow("--allow")
    await expect(program().parseAsync(runArgs(["--workspace", "relative"]), { from: "user" })).rejects.toThrow(
      "absolute",
    )
    expect(startA2aExecution).not.toHaveBeenCalled()
  })

  it.each([
    { ...endpoint, token: "PRIVATE_INLINE_TOKEN" },
    { ...endpoint, authTokenEnv: "private-token-value" },
  ])("rejects inline credentials and unsupported endpoint fields without dumping values", async (value) => {
    await writeFile(endpointFile, JSON.stringify(value))
    const error = await program()
      .parseAsync(runArgs(), { from: "user" })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("authTokenEnv")
    expect((error as Error).message).not.toContain("PRIVATE_INLINE_TOKEN")
    expect((error as Error).message).not.toContain("private-token-value")
    expect(startA2aExecution).not.toHaveBeenCalled()
  })

  it("rejects malformed or oversized endpoint JSON without dispatch", async () => {
    await writeFile(endpointFile, '{"token":"PRIVATE_TOKEN",broken}')
    await expect(program().parseAsync(runArgs(), { from: "user" })).rejects.toThrow("Invalid endpoint JSON")
    await writeFile(endpointFile, " ".repeat(65_537))
    await expect(program().parseAsync(runArgs(), { from: "user" })).rejects.toThrow("65536 bytes")
    expect(startA2aExecution).not.toHaveBeenCalled()
  })

  it.each(["SIGINT", "SIGTERM"] as const)(
    "passes %s cancellation to the service and removes both handlers",
    async (event) => {
      const initialInterrupt = process.listeners("SIGINT")
      const initialTerminate = process.listeners("SIGTERM")
      const initial = new Set(process.listeners(event))
      vi.mocked(startA2aExecution).mockImplementation(async (_options, signal, onCreated) => {
        onCreated?.(job("pending"))
        const handler = process.listeners(event).find((listener) => !initial.has(listener))
        expect(handler).toBeDefined()
        handler?.(event)
        expect(signal?.aborted).toBe(true)
        return job("unknown")
      })
      await program().parseAsync(runArgs(), { from: "user" })
      expect(process.exitCode).toBe(1)
      expect(process.listeners("SIGINT")).toEqual(initialInterrupt)
      expect(process.listeners("SIGTERM")).toEqual(initialTerminate)
    },
  )

  it("removes signal handlers when the service rejects", async () => {
    const interrupts = process.listeners("SIGINT")
    const terminations = process.listeners("SIGTERM")
    vi.mocked(startA2aExecution).mockRejectedValue(new Error("Endpoint unavailable"))
    await expect(program().parseAsync(runArgs(), { from: "user" })).rejects.toThrow("Endpoint unavailable")
    expect(process.listeners("SIGINT")).toEqual(interrupts)
    expect(process.listeners("SIGTERM")).toEqual(terminations)
  })
})

describe("A2A CLI saved execution controls", () => {
  it("resumes by saved ID without accepting a replacement goal or endpoint", async () => {
    await program().parseAsync(["a2a", "resume", id, "--workspace", root], { from: "user" })
    expect(resumeA2aExecution).toHaveBeenCalledWith(root, id, expect.any(AbortSignal))
    expect(startA2aExecution).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it("prints bounded selected status fields without prompt, credential or evidence dumps", async () => {
    const saved = job("unknown")
    if (saved.checkpoint) saved.checkpoint.state = "TASK_STATE_WORKING"
    vi.mocked(listA2aExecutions).mockResolvedValue([saved])
    await program().parseAsync(["a2a", "status", id], { from: "user" })
    const output = vi.mocked(console.log).mock.calls.flat().join("\n")
    expect(JSON.parse(output)).toEqual({
      id,
      status: "unknown",
      endpoint: "remote",
      phase: "unknown",
      remoteState: "TASK_STATE_WORKING",
      taskId: "remote-task-1",
      contextId: "remote-context-1",
      verified: false,
    })
    expect(output).not.toContain("PRIVATE_")
    expect(process.exitCode).toBe(1)
  })

  it("lists an empty store and rejects a missing selected execution", async () => {
    vi.mocked(listA2aExecutions).mockResolvedValue([])
    await program().parseAsync(["a2a", "status"], { from: "user" })
    expect(console.log).toHaveBeenCalledWith("No A2A executions.")
    expect(process.exitCode).toBe(0)
    await expect(program().parseAsync(["a2a", "status", id], { from: "user" })).rejects.toThrow("not found")
  })

  it("records explicit termination evidence separately from execution success", async () => {
    await program().parseAsync(["a2a", "reconcile", id, "--evidence", "  Remote task termination confirmed.  "], {
      from: "user",
    })
    expect(reconcileA2aExecution).toHaveBeenCalledWith(root, id, "Remote task termination confirmed.")
    expect(process.exitCode).toBe(1)
    expect(startA2aExecution).not.toHaveBeenCalled()
    expect(resumeA2aExecution).not.toHaveBeenCalled()
  })

  it.each([" ", "x".repeat(2_001)])("requires bounded termination evidence", async (evidence) => {
    await expect(
      program().parseAsync(["a2a", "reconcile", id, "--evidence", evidence], { from: "user" }),
    ).rejects.toThrow("--evidence")
    expect(reconcileA2aExecution).not.toHaveBeenCalled()
  })

  it("blocks managed Actors from starting, resuming or reconciling executions", async () => {
    vi.stubEnv("AGENT_VALLEY_MANAGED_RUN", "1")
    for (const args of [runArgs(), ["a2a", "resume", id], ["a2a", "reconcile", id, "--evidence", "Stopped."]])
      await expect(program().parseAsync(args, { from: "user" })).rejects.toThrow("already managed")
    expect(startA2aExecution).not.toHaveBeenCalled()
    expect(resumeA2aExecution).not.toHaveBeenCalled()
    expect(reconcileA2aExecution).not.toHaveBeenCalled()
  })
})
