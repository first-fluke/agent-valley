/**
 * AgySession live input — operator messages reach a running Antigravity
 * process through its open stdin (stream-json print mode) instead of a kill +
 * restart.
 *
 * A scripted stand-in for the CLI (plain JS, run by the current runtime so it
 * works on every platform) speaks the protocol captured from agy v1.5.12:
 * `{"event":"user",…}` lines in; `step_update` and `result` events out.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentConfig, AgentError, RunResult } from "../sessions/agent-session"
import { AgySession } from "../sessions/agy-session"
import * as sandboxModule from "../sessions/sandbox"

const FAKE_CLI = `
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const steps = JSON.parse(readFileSync(process.argv[2], "utf8"))
const messages = []
let closed = false
let wake = () => {}
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  try { messages.push(JSON.parse(line)) } catch {}
  wake()
})
rl.on("close", () => { closed = true; wake() })
const until = async (done) => { while (!done()) await new Promise((resolve) => { wake = resolve }) }
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n")
let index = 0
const step = (body) => emit({ event: "step_update", step_update: { conversation_id: "c1", step_index: index++, ...body } })

let exitCode = 0
let exitEarly = false
emit({ event: "init", conversation_id: "c1", init: { model: "gemini-test", cwd: process.cwd(), tools: [] } })
for (const s of steps) {
  if (s.waitMessages) await until(() => messages.length >= s.waitMessages || closed)
  if (s.take !== undefined) step({ state: "DONE", step_type: "user_input" })
  if (s.text !== undefined) step({ state: "ACTIVE", step_type: "agent_response", text_delta: s.text })
  if (s.tool) {
    const tool = { step_type: "tool", tool_name: s.tool.name, tool_info: { name: s.tool.name, parameters: s.tool.parameters } }
    const at = index
    step({ state: "ACTIVE", ...tool })
    index = at
    step({ state: "DONE", ...tool })
  }
  if (s.echoMessages) step({ state: "ACTIVE", step_type: "agent_response", text_delta: messages.map((m) => m.message.content).join("|") })
  if (s.result) emit({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", ...s.result } })
  if (s.sleep) await new Promise((resolve) => setTimeout(resolve, s.sleep))
  if (s.exit !== undefined) { exitCode = s.exit; exitEarly = true; break }
}
if (!exitEarly) await until(() => closed)
rl.close()
process.stdin.destroy()
process.exitCode = exitCode
`

const usage = (input: number, output: number, cached = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: cached,
})
const readTool = { name: "read_file", parameters: { Path: "/work/a.txt" } }

class QuickGraceSession extends AgySession {
  protected override queuedMessageGraceMs = 60
}

let dir: string
let stepsFile: string
let liveCli: string
let oldCli: string
let oneShotCli: string
let supportsStreamInput: boolean
let spawnArgs: string[][]
let sessions: AgySession[]

function script(steps: unknown[]): void {
  writeFileSync(stepsFile, JSON.stringify(steps), "utf-8")
}

function config(liveInput = true): AgentConfig {
  return { type: "antigravity", timeout: 30, workspacePath: dir, options: liveInput ? { liveInput: true } : undefined }
}

function track<T extends AgySession>(session: T): T {
  sessions.push(session)
  return session
}

function observe(session: AgySession) {
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
  dir = mkdtempSync(join(tmpdir(), "av-agy-live-"))
  stepsFile = join(dir, "steps.json")
  liveCli = join(dir, "fake-agy.mjs")
  oldCli = join(dir, "old-agy.mjs")
  oneShotCli = join(dir, "one-shot-agy.mjs")
  writeFileSync(liveCli, FAKE_CLI, "utf-8")
  writeFileSync(oldCli, `console.error("flag provided but not defined: -input-format")\nprocess.exitCode = 2\n`)
  writeFileSync(oneShotCli, `console.log("one-shot answer")\n`)
  supportsStreamInput = true
  spawnArgs = []
  sessions = []
  vi.spyOn(sandboxModule, "planSandboxedSpawn").mockImplementation(async (request) => {
    spawnArgs.push(request.args)
    const live = request.args.includes("--input-format")
    const cli = !live ? [oneShotCli] : supportsStreamInput ? [liveCli, stepsFile] : [oldCli]
    return { command: process.execPath, args: cli, sandboxed: false, platform: process.platform, networkAllowlist: [] }
  })
})

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.dispose()))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe("AgySession — live input", () => {
  test("runs the prompt over stream-json and reports text, tools, edits and usage", async () => {
    script([
      { waitMessages: 1 },
      { take: 0 },
      { text: "Creating the file. " },
      { tool: { name: "write_file", parameters: { Path: "/work/d.txt" } } },
      { tool: { name: "edit_file", parameters: { Path: "/work/e.txt" } } },
      { echoMessages: true },
      { result: { response: "Created d.txt.\n", usage: usage(100, 20, 900) } },
    ])
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    await session.execute("create d.txt")

    expect(spawnArgs[0]).toEqual(
      expect.arrayContaining(["--print=", "--input-format", "stream-json", "--output-format", "stream-json"]),
    )
    // The task travels on stdin, not in argv.
    expect(spawnArgs[0]).not.toContain("create d.txt")
    expect(seen.timeline).toEqual([
      "output:Creating the file. ",
      'tool:write_file:{"Path":"/work/d.txt"}',
      "file:add:/work/d.txt",
      'tool:edit_file:{"Path":"/work/e.txt"}',
      "file:modify:/work/e.txt",
      "output:create d.txt",
      "complete",
    ])
    expect(seen.completed[0]).toMatchObject({
      exitCode: 0,
      output: "Created d.txt.",
      filesChanged: ["/work/d.txt", "/work/e.txt"],
      // Cache reads are reported apart from input tokens and both were sent.
      tokenUsage: { input: 1000, output: 20, model: "gemini-test" },
    })
  }, 20_000)

  test("a message sent mid-turn is answered in a follow-up turn before the run completes", async () => {
    script([
      { waitMessages: 1 },
      { take: 0 },
      { tool: readTool },
      { waitMessages: 2 },
      { result: { response: "Fixed the bug.", usage: usage(10, 5) } },
      { sleep: 150 },
      { take: 1 },
      { text: "Updating the README." },
      { result: { response: "README updated.", usage: usage(13, 7) } },
    ])
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("also update the README")
    await running

    expect(spawnArgs).toHaveLength(1)
    expect(seen.timeline).toEqual(['tool:read_file:{"Path":"/work/a.txt"}', "output:Updating the README.", "complete"])
    expect(seen.completed).toHaveLength(1)
    expect(seen.completed[0]?.output).toBe("Fixed the bug.\n\nREADME updated.")
    // agy reports usage for the whole process, so the last result is the total.
    expect(seen.completed[0]?.tokenUsage).toMatchObject({ input: 13, output: 7 })
  }, 20_000)

  test("a queued message that is never taken does not hang the run", async () => {
    script([
      { waitMessages: 1 },
      { take: 0 },
      { tool: readTool },
      { waitMessages: 2 },
      { result: { response: "Done." } },
    ])
    const session = track(new QuickGraceSession())
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("one more thing")
    await running

    expect(seen.completed.map((r) => r.output)).toEqual(["Done."])
    expect(seen.errors).toEqual([])
  }, 20_000)

  test("a clean exit while a result is held completes with that result", async () => {
    script([
      { waitMessages: 1 },
      { take: 0 },
      { tool: readTool },
      { waitMessages: 2 },
      { result: { response: "Done." } },
      { exit: 0 },
    ])
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.sendUserMessage("one more thing")
    await running

    expect(seen.completed.map((r) => r.output)).toEqual(["Done."])
    expect(seen.errors).toEqual([])
  }, 20_000)

  test("a failed turn ends the run and later messages are refused", async () => {
    script([
      { waitMessages: 1 },
      { take: 0 },
      { result: { status: "ERROR", response: "", error: "model backend unavailable" } },
    ])
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    await session.execute("fix the login bug")

    expect(seen.completed).toEqual([])
    expect(seen.errors).toHaveLength(1)
    expect(seen.errors[0]).toMatchObject({ code: "CRASH", recoverable: true })
    expect(seen.errors[0]?.message).toContain("model backend unavailable")
    await expect(session.sendUserMessage("hello?")).rejects.toThrow(/Restart the run with the message/)
  }, 20_000)

  test("an agy without stream-json input falls back to the one-shot run", async () => {
    supportsStreamInput = false
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    await session.execute("hello")

    expect(spawnArgs).toHaveLength(2)
    expect(spawnArgs[0]).toContain("--input-format")
    expect(spawnArgs[1]?.slice(0, 2)).toEqual(["-p", "hello"])
    expect(seen.completed.map((r) => r.output.trim())).toEqual(["one-shot answer"])
    expect(seen.errors).toEqual([])
  }, 20_000)

  test("without live input the run stays one-shot and messages are refused", async () => {
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config(false))
    await session.execute("hello")

    expect(spawnArgs).toHaveLength(1)
    expect(spawnArgs[0]?.slice(0, 2)).toEqual(["-p", "hello"])
    expect(seen.completed.map((r) => r.output.trim())).toEqual(["one-shot answer"])
    await expect(session.sendUserMessage("hi")).rejects.toThrow(/not accepting live input/)
  }, 20_000)

  test("stopping the session mid-run does not retry it one-shot", async () => {
    script([{ waitMessages: 1 }, { take: 0 }, { tool: readTool }, { waitMessages: 2 }])
    const session = track(new AgySession())
    const seen = observe(session)

    await session.start(config())
    const running = session.execute("fix the login bug")
    await seen.toolSeen
    await session.kill()
    await running

    expect(spawnArgs).toHaveLength(1)
    expect(seen.completed).toEqual([])
    expect(seen.errors).toHaveLength(1)
  }, 20_000)
})
