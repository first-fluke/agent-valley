/**
 * Integration test — a live run fills its issue thread.
 *
 * Flow: Todo webhook → orchestrator spawns a fake codex session → the session
 * emits output and a tool call → an operator message goes through the
 * intervention bus → everything is readable, and observable live, on
 * `orchestrator.threads` under the issue key.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ThreadUpdate } from "../../domain/issue-thread"
import { registerSession } from "../../sessions/session-factory"
import { FakeAgentSession } from "../characterization/helpers"
import {
  buildOrchestratorRig,
  createGitRepo,
  makeIssuePayload,
  type OrchestratorRig,
  type RepoHandle,
  waitFor,
} from "./helpers"

vi.mock("../../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

let repo: RepoHandle
let rig: OrchestratorRig

beforeEach(async () => {
  FakeAgentSession.resetRegistry()
  repo = await createGitRepo()
  rig = buildOrchestratorRig({ workspaceRoot: repo.repoDir, overrides: { agentType: "codex", maxParallel: 2 } })
  registerSession("codex", () => {
    const session = new FakeAgentSession()
    ;(session as unknown as { sendUserMessage: (text: string) => Promise<void> }).sendUserMessage = async () => {}
    return session
  })
})

afterEach(async () => {
  await rig.stop()
  await repo.cleanup()
  vi.restoreAllMocks()
})

describe("Integration — issue thread", () => {
  test("a run's start, output, tool calls and operator messages land on the issue thread", async () => {
    const issueKey = "INT-THR-1"
    const live: ThreadUpdate[] = []
    // Attach before the run exists, as `av attach` may.
    const unsubscribe = rig.orchestrator.threads.subscribe(issueKey, (update) => live.push(update))
    const outputEvents: unknown[] = []
    rig.orchestrator.on("agent.output", (payload) => outputEvents.push(payload))

    const response = await rig.post(
      makeIssuePayload(rig.config, { id: "issue-integ-thread", identifier: issueKey, toState: "todo" }),
    )
    expect(response.status).toBe(200)

    // The attempt is registered before the session exists; wait for the run itself.
    await waitFor(() => FakeAgentSession.instances.at(-1)?.executeCalls.length === 1, {
      description: "fake session is executing the prompt",
    })
    const [attemptId] = rig.orchestrator.intervention.listAttempts()
    const session = FakeAgentSession.instances.at(-1)
    if (!attemptId || !session) throw new Error("Expected a spawned fake Actor session with a registered attempt")
    // Tracker runs ask the session to keep its input open for operator messages.
    expect(session.startCalls[0]?.options).toEqual({ liveInput: true })

    session.emit("toolUse", { type: "toolUse", tool: "Bash", args: { command: "bun test" } })
    session.emit("output", { type: "output", chunk: "Tests are green." })
    const sent = await rig.orchestrator.intervention.send(attemptId, {
      kind: "append_prompt",
      text: "also update README",
    })
    expect(sent.ok).toBe(true)

    const thread = rig.orchestrator.threads.read(issueKey).map(({ kind, text }) => ({ kind, text }))
    expect(thread).toEqual([
      { kind: "system", text: "Started codex" },
      { kind: "tool", text: "Bash: bun test" },
      { kind: "output", text: "Tests are green." },
      { kind: "operator", text: "also update README" },
    ])
    expect(rig.orchestrator.threads.read(issueKey)[2]?.attemptId).toBe(attemptId)

    // The watcher saw the same entries arrive live, and the raw event is public.
    expect(live.map((update) => update.entry.text)).toEqual(thread.map((entry) => entry.text))
    expect(outputEvents).toEqual([{ issueKey, issueId: "issue-integ-thread", attemptId, text: "Tests are green." }])
    unsubscribe()
  }, 15_000)
})
