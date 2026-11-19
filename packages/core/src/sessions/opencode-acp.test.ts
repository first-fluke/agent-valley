/**
 * OpencodeSession over ACP — runs that take operator messages hold an ACP
 * session open (`opencode acp`) instead of the one-shot `opencode run`.
 *
 * The agent side is a scripted ACP agent built on the official SDK and run by
 * the current runtime, so these tests cover the real JSON-RPC exchange on
 * every platform. See ../__tests__/fakes/fake-acp-agent.mjs for the scenario
 * format.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentConfig, AgentError, RunResult } from "./agent-session"
import { OpencodeSession } from "./opencode-session"
import * as sandboxModule from "./sandbox"

const FAKE_AGENT = fileURLToPath(new URL("../__tests__/fakes/fake-acp-agent.mjs", import.meta.url))

const readCall = {
  sessionUpdate: "tool_call",
  toolCallId: "t1",
  title: "read",
  kind: "read",
  status: "pending",
  rawInput: { path: "a.txt" },
}

let dir: string
let scenarioFile: string
let oneShotScript: string
let brokenAcpScript: string
let acpSpeaksProtocol: boolean
let spawnArgs: string[][]
let sessions: OpencodeSession[]

function scenario(value: unknown): void {
  writeFileSync(scenarioFile, JSON.stringify(value), "utf-8")
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { type: "opencode", timeout: 30, workspacePath: dir, options: { liveInput: true }, ...overrides }
}

function newSession(): OpencodeSession {
  const session = new OpencodeSession()
  sessions.push(session)
  return session
}

function observe(session: OpencodeSession) {
  const timeline: string[] = []
  const completed: RunResult[] = []
  const errors: AgentError[] = []
  let sawTool: () => void = () => {}
  const toolSeen = new Promise<void>((resolve) => {
    sawTool = resolve
  })
  session.on("output", (e) => timeline.push(`output:${e.chunk}`))
  session.on("toolUse", (e) => {
    timeline.push(`tool:${e.tool}:${JSON.stringify(e.args)}`)
    sawTool()
  })
  session.on("fileChange", (e) => timeline.push(`file:${e.changeType}:${e.path}`))
  session.on("complete", (e) => {
    timeline.push("complete")
    completed.push(e.result)
  })
  session.on("error", (e) => {
    timeline.push("error")
    errors.push(e.error)
  })
  return { timeline, completed, errors, toolSeen }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "av-opencode-acp-"))
  scenarioFile = join(dir, "scenario.json")
  oneShotScript = join(dir, "one-shot.mjs")
  brokenAcpScript = join(dir, "no-acp.mjs")
  writeFileSync(oneShotScript, `console.log(JSON.stringify({ type: "text", part: { text: "one-shot answer" } }))\n`)
  writeFileSync(brokenAcpScript, `console.error("unknown command: acp")\nprocess.exitCode = 1\n`)
  acpSpeaksProtocol = true
  spawnArgs = []
  sessions = []
  vi.spyOn(sandboxModule, "planSandboxedSpawn").mockImplementation(async (request) => {
    spawnArgs.push(request.args)
    const script =
      request.args[0] !== "acp" ? [oneShotScript] : acpSpeaksProtocol ? [FAKE_AGENT, scenarioFile] : [brokenAcpScript]
    return {
      command: process.execPath,
      args: script,
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    }
  })
})

afterEach(async () => {
  // An ACP server outlives its run until the session is disposed, and holds the directory open.
  await Promise.all(sessions.map((session) => session.dispose()))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe("OpencodeSession — ACP runs", () => {
  test("runs the prompt in an ACP session and reports text, tools, edits and usage", async () => {
    scenario({
      turns: [
        {
          steps: [
            { text: "Looking at the file. " },
            { tool: { sessionUpdate: "tool_call", toolCallId: "w1", title: "write", kind: "edit", status: "pending" } },
            {
              tool: {
                sessionUpdate: "tool_call_update",
                toolCallId: "w1",
                status: "in_progress",
                rawInput: { path: "d.txt", content: "hello" },
                locations: [{ path: "/work/d.txt" }],
              },
            },
            { tool: { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed" } },
            { text: "Done." },
          ],
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      ],
    })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("create d.txt")

    expect(spawnArgs).toEqual([["acp"]])
    expect(seen.timeline).toEqual([
      "output:Looking at the file. ",
      // Reported once, when its input became known — not at the empty `pending` stage.
      'tool:write:{"path":"d.txt","content":"hello"}',
      "file:add:/work/d.txt",
      "output:Done.",
      "complete",
    ])
    expect(seen.completed[0]).toMatchObject({
      exitCode: 0,
      output: "Looking at the file. Done.",
      filesChanged: ["/work/d.txt"],
      tokenUsage: { input: 100, output: 20, model: "unknown" },
    })
  }, 20_000)

  test("an operator message interrupts the turn and continues in the same session", async () => {
    scenario({
      refusePromptWhileBusy: true,
      turns: [
        { steps: [{ tool: readCall }, { waitForCancel: true }], usage: { inputTokens: 10, outputTokens: 1 } },
        { steps: [{ echoPrompt: true }], usage: { inputTokens: 5, outputTokens: 2 } },
      ],
    })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("read the files")
    await seen.toolSeen
    await session.sendUserMessage("skip the migration")
    await running

    // One process, one completion; the cancelled turn's partial work is not the result.
    expect(spawnArgs).toEqual([["acp"]])
    expect(seen.completed).toHaveLength(1)
    expect(seen.errors).toEqual([])
    const output = seen.completed[0]?.output ?? ""
    expect(output).toContain("The operator sent you a message while you were working:\n\nskip the migration")
    expect(output).toContain("If your earlier work was interrupted, continue it now")
    expect(seen.completed[0]?.tokenUsage).toMatchObject({ input: 15, output: 3 })
  }, 20_000)

  test("messages sent in quick succession reach the agent as one follow-up prompt", async () => {
    scenario({
      refusePromptWhileBusy: true,
      turns: [{ steps: [{ tool: readCall }, { waitForCancel: true }] }, { steps: [{ echoPrompt: true }] }],
    })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("read the files")
    await seen.toolSeen
    await Promise.all([session.sendUserMessage("first note"), session.sendUserMessage("second note")])
    await running

    expect(seen.completed).toHaveLength(1)
    expect(seen.completed[0]?.output).toContain("first note")
    expect(seen.completed[0]?.output).toContain("second note")
  }, 20_000)

  test("selects the configured model through the session config", async () => {
    scenario({ models: ["provider/default", "provider/wanted"], turns: [{ steps: [{ echoPrompt: true }] }] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config({ model: "provider/wanted" }))
    await session.execute("hello")

    expect(seen.completed[0]?.output).toBe("[model=provider/wanted] hello")
  }, 20_000)

  test("approves permission requests, preferring a standing approval", async () => {
    scenario({ turns: [{ steps: [{ askPermission: true }] }] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("write a file")

    expect(seen.completed[0]?.output).toBe("permission=always")
  }, 20_000)

  test("a failed prompt ends the run with the agent's reason", async () => {
    scenario({ turns: [{ error: "Provider returned 500 while streaming" }] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("hello")

    expect(seen.completed).toEqual([])
    expect(seen.errors).toHaveLength(1)
    expect(seen.errors[0]).toMatchObject({ code: "CRASH", recoverable: true })
    expect(seen.errors[0]?.message).toContain("OpenCode run failed over ACP")
    expect(seen.errors[0]?.message).toContain("Provider returned 500 while streaming")
  }, 20_000)

  test("a turn that stops short of the end is a failure, not a completion", async () => {
    scenario({ turns: [{ steps: [{ text: "partial" }], stop: "max_tokens" }] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("hello")

    expect(seen.completed).toEqual([])
    expect(seen.errors[0]?.message).toContain("stopped before finishing (max_tokens)")
  }, 20_000)

  test("a session refused for missing credentials is an auth failure, with no one-shot retry", async () => {
    scenario({ refuseSession: "Unauthorized: no provider configured", turns: [{}] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("hello")

    expect(spawnArgs).toEqual([["acp"]])
    expect(seen.errors).toHaveLength(1)
    expect(seen.errors[0]).toMatchObject({ code: "AUTH_FAILED", recoverable: false })
    expect(seen.errors[0]?.message).toContain("opencode auth")
  }, 20_000)

  test("a CLI without ACP support falls back to the one-shot run", async () => {
    acpSpeaksProtocol = false
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    await session.execute("hello")

    expect(spawnArgs.map((args) => args[0])).toEqual(["acp", "run"])
    expect(seen.completed.map((r) => r.output)).toEqual(["one-shot answer"])
    expect(seen.errors).toEqual([])
    await expect(session.sendUserMessage("too late")).rejects.toThrow(/Restart the run with the message/)
  }, 20_000)

  test("without live input the run stays one-shot and messages are refused", async () => {
    const session = newSession()
    const seen = observe(session)

    await session.start(config({ options: undefined }))
    await session.execute("hello")

    expect(spawnArgs.map((args) => args[0])).toEqual(["run"])
    expect(seen.completed.map((r) => r.output)).toEqual(["one-shot answer"])
    await expect(session.sendUserMessage("hi")).rejects.toThrow(/not accepting live input/)
  }, 20_000)

  test("stopping the session mid-run ends it as cancelled", async () => {
    scenario({ turns: [{ steps: [{ tool: readCall }, { waitForCancel: true }] }] })
    const session = newSession()
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("read the files")
    await seen.toolSeen
    await session.kill()
    await running

    expect(seen.completed).toEqual([])
    expect(seen.errors.map((e) => e.code)).toEqual(["CANCELLED"])
    await expect(session.sendUserMessage("hi")).rejects.toThrow(/Restart the run with the message/)
  }, 20_000)
})
