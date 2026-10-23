import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { parseJson } from "../chief/plan-validation"
import type { RunResult } from "../sessions/agent-session"
import { CodexSession } from "../sessions/codex-session"
import { planSandboxedSpawn } from "../sessions/sandbox"

vi.mock("../sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))

// Real stdio framing, without a model call. The completed agentMessage's phase
// identifies the answer; deltas also include ordinary progress narration.
const server = String.raw`
const readline = require('node:readline');
const turns = JSON.parse(process.env.TEST_CODEX_TURNS);
let sequence = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const {id, method} = JSON.parse(line);
  const reply = result => send({jsonrpc:'2.0', id, result});
  if (method === 'initialize') return reply({});
  if (method === 'thread/start') {
    sequence++;
    if (sequence > 1) {
      send({jsonrpc:'2.0',method:'item/completed',params:{
        threadId:'thread-' + (sequence - 1),turnId:'turn-' + (sequence - 1),
        item:{type:'agentMessage',id:'late-old-answer',phase:'final_answer',text:'stale previous answer'}
      }});
      send({jsonrpc:'2.0',method:'item/completed',params:{
        item:{type:'agentMessage',id:'legacy-late-answer',phase:'final_answer',text:'stale unidentified answer'}
      }});
    }
    return reply({thread:{id:'thread-' + sequence}});
  }
  if (method !== 'turn/start') return;
  const threadId = 'thread-' + sequence;
  const turnId = 'turn-' + sequence;
  const notify = (method, params) => send({jsonrpc:'2.0', method, params:{threadId,turnId,...params}});
  notify('turn/started', {turn:{id:turnId,status:'inProgress'}});
  reply({turn:{id:turnId,status:'inProgress'}});
  setTimeout(() => {
    for (const event of turns[sequence - 1]) notify(event.method, event.params);
    notify('turn/completed', {turn:{id:turnId,status:'completed'}});
  }, 10);
});
`

type Notification = { method: string; params: Record<string, unknown> }
const sessions: CodexSession[] = []
const answer = JSON.stringify({ approved: true, reason: "The check passed." })

function message(text: string, phase?: string | null): Notification {
  return { method: "item/completed", params: { item: { type: "agentMessage", id: "answer", text, phase } } }
}

function delta(text: string): Notification {
  return { method: "item/agentMessage/delta", params: { itemId: "answer", delta: text } }
}

async function start(turns: Notification[][]) {
  const session = new CodexSession()
  sessions.push(session)
  const results: RunResult[] = []
  const chunks: string[] = []
  const errors: string[] = []
  session.on("complete", ({ result }) => results.push(result))
  session.on("output", ({ chunk }) => chunks.push(chunk))
  session.on("error", ({ error }) => errors.push(error.message))
  await session.start({
    type: "codex",
    workspacePath: process.cwd(),
    timeout: 5,
    env: { TEST_CODEX_TURNS: JSON.stringify(turns) },
  })
  await session.execute("Return the requested JSON.")
  await vi.waitFor(() => expect(results).toHaveLength(1))
  expect(errors).toEqual([])
  return { session, results, chunks }
}

beforeEach(() => {
  vi.mocked(planSandboxedSpawn).mockResolvedValue({
    command: process.execPath,
    args: ["-e", server],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  })
})

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()))
})

describe("Codex final answer output", () => {
  test("keeps progress live and passes only the declared final answer to the Chief JSON parser", async () => {
    const progress = "I will inspect the fixture before returning the requested JSON."
    const { results, chunks } = await start([
      [delta(progress), message(progress, "commentary"), delta(answer), message(answer, "final_answer")],
    ])
    expect(chunks.join("")).toBe(progress + answer)
    expect(parseJson(results[0]?.output ?? "", "Review")).toEqual(JSON.parse(answer))
  })

  test.each(["final_answer", undefined, null])("uses completed text without deltas (phase %s)", async (phase) => {
    const { results } = await start([[message(answer, phase)]])
    expect(results[0]?.output).toBe(answer)
  })

  test("does not let later progress or unphased text replace an explicit final answer", async () => {
    const { results } = await start([
      [message(answer, "final_answer"), message("Finishing cleanup.", "commentary"), message("Other message")],
    ])
    expect(results[0]?.output).toBe(answer)
  })

  test.each(["commentary", "partial_answer"])("does not promote %s to a completed answer", async (phase) => {
    const { results } = await start([[delta(answer), message(answer, phase)]])
    expect(results[0]?.output).toBe("")
  })

  test("ignores answer items for another thread or turn", async () => {
    const wrongThread = message("wrong thread", "final_answer")
    wrongThread.params.threadId = "another-thread"
    const wrongTurn = message("wrong turn", "final_answer")
    wrongTurn.params.turnId = "another-turn"
    const { results } = await start([[message(answer, "final_answer"), wrongThread, wrongTurn]])
    expect(results[0]?.output).toBe(answer)
  })

  test("retains delta-only compatibility and resets answer selection for the next execution", async () => {
    const { session, results } = await start([[message(answer, "final_answer")], [delta("legacy answer")]])
    await session.execute("Next turn")
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(results.map((result) => result.output)).toEqual([answer, "legacy answer"])
  })

  test("cannot reuse a late answer from the previous thread while opening a new one", async () => {
    const { session, results } = await start([
      [message(answer, "final_answer")],
      [message("Still working.", "commentary")],
    ])
    await session.execute("Next turn")
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(results[1]?.output).toBe("")
  })
})
