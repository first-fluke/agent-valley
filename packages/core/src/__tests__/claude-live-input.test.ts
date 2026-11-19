/**
 * ClaudeSession live input — operator messages reach a running Claude process
 * through its open stdin instead of a kill + restart.
 *
 * A scripted stand-in for the CLI (plain JS, run by the current runtime so it
 * works on every platform) speaks the stream-json protocol: it reads NDJSON
 * user messages from stdin, echoes one back with `isReplay` when it "takes" it,
 * and exits once stdin closes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentConfig, AgentSession, RunResult } from "../sessions/agent-session"
import { ClaudeSession } from "../sessions/claude-session"
import * as sandboxModule from "../sessions/sandbox"

const FAKE_CLI = `
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const steps = JSON.parse(readFileSync(process.argv[2], "utf8"))
const raw = []
const messages = []
let closed = false
let wake = () => {}
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  raw.push(line)
  try { messages.push(JSON.parse(line)) } catch {}
  wake()
})
rl.on("close", () => { closed = true; wake() })
const until = async (done) => { while (!done()) await new Promise((resolve) => { wake = resolve }) }
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n")
const textOf = (message) => message.message.content[0].text

let exitCode = 0
let exitEarly = false
for (const step of steps) {
  if (step.waitMessages) await until(() => messages.length >= step.waitMessages || closed)
  if (step.replay !== undefined) emit({ ...messages[step.replay], isReplay: true })
  if (step.emit) emit(step.emit)
  if (step.resultFromMessages) emit({ type: "result", is_error: false, result: messages.map(textOf).join("|") })
  if (step.resultFromRawInput) {
    await until(() => closed)
    emit({ type: "result", is_error: false, result: raw.join("\\n") })
  }
  if (step.sleep) await new Promise((resolve) => setTimeout(resolve, step.sleep))
  if (step.exit !== undefined) { exitCode = step.exit; exitEarly = true; break }
}
if (!exitEarly) await until(() => closed)
rl.close()
process.stdin.destroy()
process.exitCode = exitCode
`

const toolCall = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] },
}
const result = (text: string, usage?: { input_tokens: number; output_tokens: number }) => ({
  type: "result",
  is_error: false,
  result: text,
  model: "claude-test",
  ...(usage ? { usage } : {}),
})

class QuickGraceSession extends ClaudeSession {
  protected override queuedMessageGraceMs = 60
}

let dir: string
let stepsFile: string
let spawnArgs: string[][]

function script(steps: unknown[]): void {
  writeFileSync(stepsFile, JSON.stringify(steps), "utf-8")
}

function config(liveInput: boolean): AgentConfig {
  return { type: "claude", timeout: 30, workspacePath: dir, options: liveInput ? { liveInput: true } : undefined }
}

/** Collect what a consumer of the session observes, in order. */
function observe(session: AgentSession) {
  const timeline: string[] = []
  const completed: RunResult[] = []
  const errors: string[] = []
  let sawTool: () => void = () => {}
  const toolSeen = new Promise<void>((resolve) => {
    sawTool = resolve
  })
  session.on("output", (e) => timeline.push(`output:${e.chunk}`))
  session.on("toolUse", (e) => {
    timeline.push(`tool:${e.tool}`)
    sawTool()
  })
  session.on("complete", (e) => {
    timeline.push("complete")
    completed.push(e.result)
  })
  session.on("error", (e) => {
    timeline.push("error")
    errors.push(e.error.message)
  })
  return { timeline, completed, errors, toolSeen }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "av-claude-live-"))
  stepsFile = join(dir, "steps.json")
  const cli = join(dir, "fake-claude.mjs")
  writeFileSync(cli, FAKE_CLI, "utf-8")
  spawnArgs = []
  vi.spyOn(sandboxModule, "planSandboxedSpawn").mockImplementation(async (request) => {
    spawnArgs.push(request.args)
    return {
      command: process.execPath,
      args: [cli, stepsFile],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe("ClaudeSession — live input", () => {
  test("opens a streaming stdin and sends the prompt as a user message", async () => {
    script([{ waitMessages: 1 }, { replay: 0 }, { resultFromMessages: true }])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    await session.execute("fix the login bug")

    expect(spawnArgs[0]).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--replay-user-messages"]))
    expect(seen.completed.map((r) => r.output)).toEqual(["fix the login bug"])
    // execute() only returns once the process is gone, so stdin was closed after the result.
    expect(seen.errors).toEqual([])
  }, 15_000)

  test("without liveInput the prompt stays a one-shot plain write and messages are refused", async () => {
    script([{ resultFromRawInput: true }])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(false))
    await session.execute("plain prompt")

    expect(spawnArgs[0]).not.toContain("--input-format")
    expect(seen.completed.map((r) => r.output)).toEqual(["plain prompt"])
    await expect(session.sendUserMessage("too late")).rejects.toThrow(/not accepting live input.*Restart the run/)
  }, 15_000)

  test("a message sent mid-turn is taken by the running process and the run finishes once", async () => {
    script([
      { waitMessages: 1 },
      { replay: 0 },
      { emit: toolCall },
      { waitMessages: 2 },
      { replay: 1 },
      { resultFromMessages: true },
    ])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("skip the migration")
    await running

    expect(seen.timeline).toEqual(["tool:Bash", "complete"])
    expect(seen.completed[0]?.output).toBe("fix the login bug|skip the migration")
  }, 15_000)

  test("a message queued behind a finished turn is answered before the run completes", async () => {
    script([
      { waitMessages: 1 },
      { replay: 0 },
      { emit: toolCall },
      { waitMessages: 2 },
      { emit: result("Fixed the bug.", { input_tokens: 10, output_tokens: 5 }) },
      { sleep: 150 },
      { replay: 1 },
      { emit: { type: "assistant", message: { content: [{ type: "text", text: "Updating the README." }] } } },
      { emit: result("README updated.", { input_tokens: 3, output_tokens: 2 }) },
    ])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("also update the README")
    await running

    // The first result did not end the run: the follow-up turn streamed before completion.
    expect(seen.timeline).toEqual(["tool:Bash", "output:Updating the README.", "complete"])
    expect(seen.completed).toHaveLength(1)
    expect(seen.completed[0]?.output).toBe("Fixed the bug.\n\nREADME updated.")
    expect(seen.completed[0]?.tokenUsage).toEqual({ input: 13, output: 7, model: "claude-test" })
  }, 15_000)

  test("a result that reports queued turns does not end the run", async () => {
    script([
      { waitMessages: 1 },
      { replay: 0 },
      { emit: { ...result("Part one."), queued_turn_count: 1 } },
      { sleep: 100 },
      { emit: { type: "assistant", message: { content: [{ type: "text", text: "Continuing." }] } } },
      { emit: result("Part two.") },
    ])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    await session.execute("fix the login bug")

    expect(seen.timeline).toEqual(["output:Continuing.", "complete"])
    expect(seen.completed[0]?.output).toBe("Part one.\n\nPart two.")
  }, 15_000)

  test("a queued message that is never taken does not hang the run", async () => {
    script([{ waitMessages: 1 }, { replay: 0 }, { emit: toolCall }, { waitMessages: 2 }, { emit: result("Done.") }])
    const session = new QuickGraceSession()
    const seen = observe(session)

    await session.start(config(true))
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("one more thing")
    await running

    expect(seen.completed.map((r) => r.output)).toEqual(["Done."])
    expect(seen.errors).toEqual([])
  }, 15_000)

  test("a clean exit while a result is held completes with that result", async () => {
    script([
      { waitMessages: 1 },
      { replay: 0 },
      { emit: toolCall },
      { waitMessages: 2 },
      { emit: result("Done.") },
      { exit: 0 },
    ])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("one more thing")
    await running

    expect(seen.completed.map((r) => r.output)).toEqual(["Done."])
    expect(seen.errors).toEqual([])
  }, 15_000)

  test("an error result ends the run and later messages are refused", async () => {
    script([{ waitMessages: 1 }, { replay: 0 }, { emit: { type: "result", is_error: true, result: "boom" } }])
    const session = new ClaudeSession()
    const seen = observe(session)

    await session.start(config(true))
    await session.execute("fix the login bug")

    expect(seen.errors).toEqual(["boom"])
    expect(seen.completed).toEqual([])
    await expect(session.sendUserMessage("hello?")).rejects.toThrow(/Restart the run with the message/)
  }, 15_000)
})
