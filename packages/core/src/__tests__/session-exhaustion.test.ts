import { afterEach, describe, expect, test, vi } from "vitest"
import { classifyAgentExhaustion } from "../domain/agent-exhaustion"
import type { AgentEvent, AgentSession } from "../sessions/agent-session"
import { AgySession } from "../sessions/agy-session"
import { ClaudeSession } from "../sessions/claude-session"
import { CodexSession } from "../sessions/codex-session"
import { CursorSession } from "../sessions/cursor-session"
import { KimiSession } from "../sessions/kimi-session"
import { OpencodeSession } from "../sessions/opencode-session"
import { QwenSession } from "../sessions/qwen-session"
import { planSandboxedSpawn } from "../sessions/sandbox"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

const sessions: AgentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()))
  vi.resetAllMocks()
})

function errors(session: AgentSession) {
  const failures: Extract<AgentEvent, { type: "error" }>[] = []
  session.on("error", (event) => failures.push(event))
  return failures
}

async function claude(events: unknown[]) {
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>{for(const event of JSON.parse(process.env.TEST_EVENTS))process.stdout.write(JSON.stringify(event)+'\\n')})",
    ],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
  const session = new ClaudeSession()
  sessions.push(session)
  const failures = errors(session)
  await session.start({
    type: "claude",
    workspacePath: process.cwd(),
    timeout: 5,
    env: { TEST_EVENTS: JSON.stringify(events) },
  })
  await session.execute("Continue the task")
  return failures
}

const codexServer = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const {id, method} = JSON.parse(line);
  if (method === 'initialize') return send({jsonrpc:'2.0',id,result:{}});
  if (method === 'thread/start') return send({jsonrpc:'2.0',id,result:{thread:{id:'thread'}}});
  if (method === 'turn/start') {
    send({jsonrpc:'2.0',id,result:{turn:{id:'turn'}}});
    setTimeout(() => send(JSON.parse(process.env.TEST_EVENT)),10);
  }
});
`

async function codex(event: unknown) {
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: ["-e", codexServer],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
  const session = new CodexSession()
  sessions.push(session)
  const failures = errors(session)
  await session.start({
    type: "codex",
    workspacePath: process.cwd(),
    timeout: 5,
    env: { TEST_EVENT: JSON.stringify(event) },
  })
  await session.execute("Continue the task")
  await vi.waitFor(() => expect(failures).toHaveLength(1))
  return failures
}

describe("native session exhaustion errors", () => {
  test("preserves Claude terminal errors when result text is absent", async () => {
    const failures = await claude([
      { type: "result", is_error: true, subtype: "error_during_execution", errors: ["Prompt is too long"] },
    ])
    expect(failures).toHaveLength(1)
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("context")
  })

  test("retains Claude assistant provider errors until terminal failure", async () => {
    const failures = await claude([
      {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 5pm" }] },
      },
      { type: "result", is_error: true, subtype: "error_during_execution", errors: [] },
    ])
    expect(failures).toHaveLength(1)
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("usage")
  })

  test("uses retained Claude provider error when the CLI omits its result", async () => {
    const failures = await claude([
      {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "Your credit balance is too low" }] },
      },
    ])
    expect(failures).toHaveLength(1)
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("usage")
  })

  test("does not classify Claude local max-turn limits as provider exhaustion", async () => {
    const failures = await claude([{ type: "result", is_error: true, subtype: "error_max_turns", errors: [] }])
    expect(failures[0]?.error.message).toBe("error_max_turns")
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBeUndefined()
  })

  test("preserves Codex contextWindowExceeded on a failed turn", async () => {
    const failures = await codex({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "turn",
          status: "failed",
          error: { message: "The request failed", codexErrorInfo: "contextWindowExceeded" },
        },
      },
    })
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("context")
  })

  test("preserves Codex usageLimitExceeded on a terminal provider error", async () => {
    const failures = await codex({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId: "thread",
        error: { message: "The request failed", codexErrorInfo: "usageLimitExceeded" },
        willRetry: false,
      },
    })
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("usage")
  })
})

const adapters = [
  { type: "qwen", create: () => new QwenSession() },
  { type: "cursor", create: () => new CursorSession() },
  { type: "kimi", create: () => new KimiSession() },
  { type: "opencode", create: () => new OpencodeSession() },
] as const

async function nativeFailure(
  adapter: { type: "claude" | "qwen" | "cursor" | "kimi" | "antigravity" | "opencode"; create: () => AgentSession },
  events: unknown[],
  stderr = "",
) {
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: [
      "-e",
      "const {events,stderr}=JSON.parse(process.env.TEST_FAILURE);for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');process.stderr.write(stderr);process.exitCode=1",
    ],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
  const session = adapter.create()
  sessions.push(session)
  const failures = errors(session)
  await session.start({
    type: adapter.type,
    workspacePath: process.cwd(),
    timeout: 5,
    env: { TEST_FAILURE: JSON.stringify({ events, stderr }) },
  })
  await session.execute("Continue the task")
  expect(failures).toHaveLength(1)
  return failures[0]?.error.message ?? ""
}

describe("other native adapter exhaustion errors", () => {
  test("Codex propagates exhausted allowance from failed app-server startup", async () => {
    vi.mocked(planSandboxedSpawn).mockResolvedValue({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('private-setting=never-report-this\\ninsufficient_quota\\n');process.exitCode=1",
      ],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    })
    const session = new CodexSession()
    sessions.push(session)
    const failures = errors(session)
    await expect(session.start({ type: "codex", workspacePath: process.cwd(), timeout: 5 })).rejects.toThrow(
      "usage_limit_reached",
    )
    expect(classifyAgentExhaustion(failures[0]?.error.message ?? "")).toBe("usage")
    expect(failures[0]?.error.message).not.toContain("never-report-this")
  })

  test.each(adapters)("$type preserves structured provider codes and errors[]", async (adapter) => {
    const message = await nativeFailure(adapter, [
      {
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        errors: [{ code: "insufficient_quota", message: "The request failed" }],
      },
    ])
    expect(classifyAgentExhaustion(message)).toBe("usage")
    if (adapter.type !== "qwen") expect(message).toContain("The request failed")
  })

  test.each(adapters)("$type preserves structured context errors", async (adapter) => {
    const message = await nativeFailure(adapter, [
      {
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        error: { code: "context_length_exceeded", message: "The request failed" },
      },
    ])
    expect(classifyAgentExhaustion(message)).toBe("context")
  })

  test.each([
    ...adapters,
    { type: "claude", create: () => new ClaudeSession() },
    { type: "antigravity", create: () => new AgySession() },
  ] as const)("$type propagates stderr exhaustion without copying unrelated stderr", async (adapter) => {
    const message = await nativeFailure(
      adapter,
      [],
      "private-setting=never-report-this\nYour credit balance is too low\n",
    )
    expect(classifyAgentExhaustion(message)).toBe("usage")
    expect(message).not.toContain("never-report-this")
  })
})
