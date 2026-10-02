import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentSession, RunResult } from "../sessions/agent-session"
import { ClaudeSession } from "../sessions/claude-session"
import { CodexSession } from "../sessions/codex-session"
import { CursorSession } from "../sessions/cursor-session"
import { GrokSession } from "../sessions/grok-session"
import { KimiSession } from "../sessions/kimi-session"
import { OpencodeSession } from "../sessions/opencode-session"
import { planSandboxedSpawn } from "../sessions/sandbox"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

// Strict transport fixture: fields follow codex-cli 0.160.0's generated schema.
// No model invocation or external service is involved.
const server = String.raw`
const readline = require('node:readline');
const mode = process.env.TEST_MODE;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({jsonrpc:'2.0', method, params: {threadId:'thread-1', ...params}});
const turn = (status) => ({id:'turn-1', status, items:[], error: status === 'failed' ? {message:'provider unavailable'} : null});
let initialized = false;
if (mode === 'startup-exit') process.exit(2);
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const {id, method, params = {}} = request;
  const reply = (result) => send({jsonrpc:'2.0', id, result});
  const reject = (message) => send({jsonrpc:'2.0', id, error:{code:-32602, message}});
  if (method === 'initialize') return reply({});
  if (method === 'initialized') { initialized = true; return; }
  if (!initialized) return reject('initialized notification required');
  if (method === 'thread/start') return reply({thread:{id:'thread-1'}});
  if (method === 'turn/start') {
    notify('turn/started', {turn:turn('inProgress')});
    reply({turn:turn('inProgress')});
    if (mode === 'active') return;
    setTimeout(() => {
      if (mode === 'crash') return process.exit(3);
      if (mode === 'retry') notify('error', {turnId:'turn-1', error:{message:'retrying'}, willRetry:true});
      if (mode === 'usage') {
        notify('thread/tokenUsage/updated', {turnId:'turn-1', tokenUsage:{total:{inputTokens:120, outputTokens:30},last:{inputTokens:40,outputTokens:10}}});
        notify('item/completed', {turnId:'turn-1', item:{type:'fileChange',changes:[{path:'src/fix.ts',kind:{type:'update'}}]}});
      }
      notify('turn/completed', mode === 'missing-status' ? {} : {turn:turn(mode === 'failed' ? 'failed' : 'completed')});
    }, 20);
    return;
  }
  if (method === 'turn/steer') {
    if (params.expectedTurnId !== 'turn-1') return reject('expectedTurnId required');
    notify('item/agentMessage/delta', {delta:params.input[0].text});
    return reply({turnId:'turn-1'});
  }
  if (method === 'turn/interrupt') {
    if (params.turnId !== 'turn-1') return reject('turnId required');
    reply({});
    notify('turn/completed', {turn:turn('interrupted')});
    return;
  }
  reject('unsupported method ' + method);
});
`

let sessions: AgentSession[] = []
function useScript(script: string): void {
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: ["-e", script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
}

beforeEach(() => {
  sessions = []
  useScript(server)
})
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.dispose()))
})

async function startCodex(mode: string) {
  const session = new CodexSession()
  sessions.push(session)
  const completions: RunResult[] = []
  const errors: string[] = []
  session.on("complete", ({ result }) => completions.push(result))
  session.on("error", ({ error }) => errors.push(error.message))
  await session.start({ type: "codex", workspacePath: process.cwd(), timeout: 5, env: { TEST_MODE: mode } })
  await session.execute("Fix the task")
  return { session, completions, errors }
}

describe("Codex app-server protocol", () => {
  test("handshakes, steers and interrupts the active turn", async () => {
    const { session, completions, errors } = await startCodex("active")
    const output: string[] = []
    session.on("output", ({ chunk }) => output.push(chunk))
    await session.sendUserMessage("Also check tests")
    expect(output).toContain("Also check tests")
    await session.cancel()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toContain("interrupted")
    expect(completions).toHaveLength(0)
  })

  test.each(["failed", "missing-status"])("never delivers a %s turn as success", async (mode) => {
    const { completions, errors } = await startCodex(mode)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(completions).toHaveLength(0)
  })

  test("lets the app server retry a transient provider error", async () => {
    const { completions, errors } = await startCodex("retry")
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(errors).toHaveLength(0)
  })

  test("accounts for usage notifications and completed file changes", async () => {
    const { completions } = await startCodex("usage")
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0]?.tokenUsage).toEqual({ input: 120, output: 30, model: "codex" })
    expect(completions[0]?.filesChanged).toEqual(["src/fix.ts"])
  })

  test("process death fails an active task immediately", async () => {
    const { session, completions, errors } = await startCodex("crash")
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toContain("app-server exited")
    expect(session.isAlive()).toBe(false)
    expect(completions).toHaveLength(0)
  })

  test("startup process exit rejects initialize without waiting for the RPC timeout", async () => {
    await expect(startCodex("startup-exit")).rejects.toThrow("app-server exited")
  })

  test("a missing executable rejects start without an uncaught process error", async () => {
    vi.mocked(planSandboxedSpawn).mockResolvedValue({
      command: "/nonexistent/av-test-agent",
      args: [],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    })
    await expect(startCodex("active")).rejects.toThrow("ENOENT")
  })
})

test("OpenCode explicit errors cannot succeed even when the process exits zero", async () => {
  useScript(
    `process.stdout.write(JSON.stringify({type:"error",error:{data:{message:"provider rejected"}}}), () => process.exit(0))`,
  )
  const session = new OpencodeSession()
  sessions.push(session)
  const errors: string[] = []
  const results: RunResult[] = []
  session.on("error", ({ error }) => errors.push(error.message))
  session.on("complete", ({ result }) => results.push(result))
  await session.start({ type: "opencode", workspacePath: process.cwd(), timeout: 5 })
  await session.execute("test")
  expect(errors).toEqual(["provider rejected"])
  expect(results).toHaveLength(0)
})

describe.each([
  ["claude", ClaudeSession],
  ["cursor", CursorSession],
  ["grok", GrokSession],
  ["kimi", KimiSession],
] as const)("%s subprocess lifecycle", (type, Session) => {
  test("parses the final result without a newline and drains stderr", async () => {
    const record = type === "grok" ? { type: "end", message: "done" } : { type: "result", result: "done" }
    useScript(
      `process.stdin.resume(); process.stderr.write('x'.repeat(1024 * 1024), () => { process.stdout.write(${JSON.stringify(JSON.stringify(record))}, () => process.exit(0)) })`,
    )
    const session = new Session()
    sessions.push(session)
    const completed: RunResult[] = []
    session.on("complete", ({ result }) => completed.push(result))
    await session.start({ type, workspacePath: process.cwd(), timeout: 5 })
    await session.execute("test")
    expect(completed).toHaveLength(1)
    expect(completed[0]?.exitCode).toBe(0)
  })

  test("fails an empty successful process exit instead of occupying a slot until timeout", async () => {
    useScript("process.exit(0)")
    const session = new Session()
    sessions.push(session)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error.message))
    await session.start({ type, workspacePath: process.cwd(), timeout: 5 })
    await session.execute("test")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("without a result event")
  })
})
