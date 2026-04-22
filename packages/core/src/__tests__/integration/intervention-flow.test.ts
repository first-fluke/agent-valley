/**
 * Integration test — end-to-end live intervention through the orchestrator.
 *
 * Flow (v0.2 M3):
 *   Todo webhook → orchestrator spawns a codex-capable fake session →
 *   dashboard-style POST body hits orchestrator.intervention.send(pause) →
 *   agent.paused event visible on the orchestrator event stream →
 *   resume → agent.resumed → abort → agent.aborted → cleanup.
 *
 * The goal is to cover the Presentation → Application seam without
 * spinning up the Next.js route handler: we construct the same
 * `{ attemptId, command }` body shape the route handler validates and
 * delegate straight into `orchestrator.intervention.send`, which is
 * what the route does internally.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
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

interface CodexCapableFake extends FakeAgentSession {
  pause: () => Promise<void>
  resume: () => Promise<void>
  sendUserMessage: (text: string) => Promise<void>
  pauseCalls: number
  resumeCalls: number
  sentUserMessages: string[]
}

function registerCodexFake(): void {
  registerSession("codex", () => {
    const base = new FakeAgentSession() as CodexCapableFake
    base.pauseCalls = 0
    base.resumeCalls = 0
    base.sentUserMessages = []
    base.pause = async () => {
      base.pauseCalls++
    }
    base.resume = async () => {
      base.resumeCalls++
    }
    base.sendUserMessage = async (text: string) => {
      base.sentUserMessages.push(text)
    }
    // Also register for claude so the default agent wiring doesn't crash when
    // the config defaults to claude (no routing rule matches).
    return base
  })
  registerSession("claude", () => new FakeAgentSession())
}

beforeEach(async () => {
  FakeAgentSession.resetRegistry()
  repo = await createGitRepo()
  // Run with agent type codex so the orchestrator picks up the capability
  // set that includes pause/resume.
  rig = buildOrchestratorRig({
    workspaceRoot: repo.repoDir,
    overrides: { agentType: "codex", maxParallel: 2 },
  })
  registerCodexFake()
})

afterEach(async () => {
  await rig.stop()
  await repo.cleanup()
  vi.restoreAllMocks()
})

// Mirrors the validation contract in apps/dashboard/src/app/api/intervention/route.ts.
async function postIntervention(body: {
  attemptId: string
  command: unknown
}): Promise<{ ok: boolean; reason?: string }> {
  if (!body.attemptId) return { ok: false, reason: "invalid" }
  const bus = rig.orchestrator.intervention
  const result = await bus.send(body.attemptId, body.command as never)
  return result
}

describe("Integration — live intervention (pause / resume / abort)", () => {
  test("pause + resume + abort reach the live fake codex session and emit orchestrator events", async () => {
    // Telemetry observers mirroring the production SSE bridge.
    const paused: Array<Record<string, unknown>> = []
    const resumed: Array<Record<string, unknown>> = []
    const aborted: Array<Record<string, unknown>> = []
    rig.orchestrator.on("agent.paused", (p) => paused.push(p as Record<string, unknown>))
    rig.orchestrator.on("agent.resumed", (p) => resumed.push(p as Record<string, unknown>))
    rig.orchestrator.on("agent.aborted", (p) => aborted.push(p as Record<string, unknown>))

    const payload = makeIssuePayload(rig.config, {
      id: "issue-integ-interv",
      identifier: "INT-LIV-1",
      title: "feat: intervention",
      toState: "todo",
    })

    const response = await rig.post(payload)
    expect(response.status).toBe(200)

    // Wait for the session to spawn and the intervention bus to register it.
    await waitFor(() => rig.orchestrator.intervention.listAttempts().length === 1, {
      description: "intervention bus has one registered attempt",
    })

    const [attemptId] = rig.orchestrator.intervention.listAttempts()
    expect(attemptId).toBeDefined()
    if (!attemptId) throw new Error("attempt id missing from intervention bus")

    // Retrieve the fake session so we can assert native method dispatch.
    const fakes = FakeAgentSession.instances.filter((s): s is CodexCapableFake => "pause" in s)
    expect(fakes.length).toBeGreaterThan(0)
    const session = fakes[0]
    if (!session) throw new Error("codex-capable fake session missing")

    // 1) Pause
    const pauseResult = await postIntervention({ attemptId, command: { kind: "pause" } })
    expect(pauseResult.ok).toBe(true)
    expect(session.pauseCalls).toBe(1)
    await waitFor(() => paused.length === 1, { description: "agent.paused telemetry emitted" })
    expect(paused[0]?.attemptId).toBe(attemptId)

    // 2) Resume
    const resumeResult = await postIntervention({ attemptId, command: { kind: "resume" } })
    expect(resumeResult.ok).toBe(true)
    expect(session.resumeCalls).toBe(1)
    await waitFor(() => resumed.length === 1, { description: "agent.resumed telemetry emitted" })

    // 3) Append prompt — codex supports native sendUserMessage, so the bus
    //    should dispatch to the session without cancelling it.
    const appendResult = await postIntervention({
      attemptId,
      command: { kind: "append_prompt", text: "also update README" },
    })
    expect(appendResult.ok).toBe(true)
    expect(session.sentUserMessages.length).toBe(1)
    expect(session.sentUserMessages[0]).toContain("also update README")

    // 4) Abort
    const abortResult = await postIntervention({
      attemptId,
      command: { kind: "abort", reason: "integration-test" },
    })
    expect(abortResult.ok).toBe(true)
    await waitFor(() => aborted.length === 1, { description: "agent.aborted telemetry emitted" })
    expect(aborted[0]?.reason).toBe("integration-test")

    // Invalid attempt id path — exercises the `unknown_attempt` branch that
    // the HTTP route maps to 404.
    const missing = await postIntervention({ attemptId: "does-not-exist", command: { kind: "pause" } })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe("unknown_attempt")
  }, 15_000)
})
