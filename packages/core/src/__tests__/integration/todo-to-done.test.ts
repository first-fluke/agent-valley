/**
 * Integration test — Todo → In Progress → Done happy path.
 *
 * Wires a real LinearWebhookReceiver + real WorkspaceManager (on top of a
 * real temp git repo) + FakeIssueTracker + FakeAgentSession so the full
 * orchestrator pipeline runs in-process. The only thing mocked out is the
 * external network (Linear) and the agent process.
 *
 * Scope (v0.2 M3 integration coverage):
 *   1. Webhook HMAC verified → Todo routed through updateIssueState
 *   2. Workspace is materialised as a real git worktree under the repo
 *   3. FakeAgentSession completes with a committed file change
 *   4. mergeAndPush fast-forwards main to the feature branch
 *   5. Work summary comment posted + state transition to done
 *   6. State cleanup: activeWorkspaces == 0, waitingIssues == 0
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { registerSession } from "../../sessions/session-factory"
import { FakeAgentSession, flushMicrotasks } from "../characterization/helpers"
import {
  buildOrchestratorRig,
  createGitRepo,
  makeIssuePayload,
  type OrchestratorRig,
  type RepoHandle,
  waitFor,
} from "./helpers"

// Prevent the real built-in session imports from registering claude/codex/gemini
// — we want to guarantee our fake is invoked.
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
  rig = buildOrchestratorRig({
    workspaceRoot: repo.repoDir,
    overrides: { deliveryMode: "merge", maxParallel: 2 },
  })

  // Register a fake claude session that, when started, writes a real file
  // into the worktree, commits it, and then emits the `complete` event so
  // the completion handler runs against a repo with a genuine diff.
  registerSession("claude", () => {
    const session = new FakeAgentSession()
    const originalExecute = session.execute.bind(session)
    session.execute = async (prompt: string) => {
      await originalExecute(prompt)
      const startConfig = session.startCalls.at(-1)
      if (!startConfig) throw new Error("FakeAgentSession.execute invoked before start()")
      const filePath = join(startConfig.workspacePath, "agent-output.txt")
      // Keep the content whitespace-clean so git diff --check in the
      // delivery strategy (see workspace/delivery-strategy.ts) does not
      // reject the branch. A short identifier of the prompt length is
      // enough to prove the prompt reached execute().
      const snippet = `agent received ${prompt.length} prompt chars`
      await writeFile(filePath, `${snippet.trim()}\n`)
      execSync("git add agent-output.txt", { cwd: startConfig.workspacePath })
      execSync('git -c user.email=agent@test.local -c user.name=Agent commit -m "feat: integration output"', {
        cwd: startConfig.workspacePath,
      })
      // Emit `complete` synchronously after the commit so the orchestrator
      // sees a dirty main (safety-net) = false and hasCodeChanges = true.
      session.emit("complete", {
        type: "complete",
        result: {
          exitCode: 0,
          output: "integration success",
          durationMs: 42,
          filesChanged: ["agent-output.txt"],
        },
      })
    }
    return session
  })
})

afterEach(async () => {
  await rig.stop()
  await repo.cleanup()
  vi.restoreAllMocks()
})

describe("Integration — Todo → Done happy path", () => {
  test("webhook routes Todo, runs fake agent, commits file, merges to main, transitions to done", async () => {
    const payload = makeIssuePayload(rig.config, {
      id: "issue-integ-1",
      identifier: "INT-1",
      title: "feat: integration todo",
      toState: "todo",
    })

    const response = await rig.post(payload)
    expect(response.status).toBe(200)

    // Orchestrator posts the ack + Todo→InProgress transition synchronously
    // on the webhook path. Wait for the agent to be spawned.
    await waitFor(() => FakeAgentSession.instances.length === 1, {
      description: "FakeAgentSession.instances.length === 1",
    })
    await flushMicrotasks()

    // ── 1. Tracker state transition through Todo → InProgress ──
    const trackerCalls = rig.tracker.calls.map((c) => c.method)
    expect(trackerCalls).toContain("updateIssueState")
    const toInProgress = rig.tracker.calls.find(
      (c) => c.method === "updateIssueState" && c.args[1] === rig.config.workflowStates.inProgress,
    )
    expect(toInProgress).toBeDefined()

    // ── 2. Workspace materialised as a real worktree on disk ──
    const worktreePath = join(repo.repoDir, "INT-1")
    await waitFor(() => existsSync(worktreePath), {
      description: `worktree directory ${worktreePath} exists`,
    })
    expect(existsSync(join(worktreePath, ".git"))).toBe(true)

    // ── 3. FakeAgentSession spawned with the resolved workspace path ──
    const session = FakeAgentSession.instances[0]
    expect(session?.startCalls).toHaveLength(1)
    expect(session?.startCalls[0]?.workspacePath).toBe(worktreePath)
    expect(session?.executeCalls).toHaveLength(1)

    // ── 4. Wait for completion → merge → transition to done ──
    await waitFor(
      () =>
        rig.tracker.calls.some((c) => c.method === "updateIssueState" && c.args[1] === rig.config.workflowStates.done),
      {
        // Under parallel test load the git merge+push step can stretch to
        // several seconds; keep a generous ceiling so this never flakes.
        timeoutMs: 8_000,
        description: "updateIssueState(done) to be called",
      },
    )

    // ── 5. Work summary comment posted ──
    const comments = rig.tracker.comments.get("issue-integ-1") ?? []
    expect(comments.length).toBeGreaterThanOrEqual(1)
    // Summary contains either a duration or diff indicator, depending on stat
    const summaryLine = comments.join("\n")
    expect(summaryLine).toMatch(/Symphony|Work Summary|complete|integration/i)

    // ── 6. Merge fast-forwarded main to the feature branch ──
    const mainLog = execSync("git log --format=%s main", { cwd: repo.repoDir, encoding: "utf-8" })
    expect(mainLog).toContain("feat: integration output")

    // ── 7. Orchestrator runtime state drained ──
    const status = rig.orchestrator.getHandlers().getStatus() as {
      activeWorkspaces: unknown[]
      waitingIssues: number
      retryQueueSize: number
    }
    expect(status.activeWorkspaces).toHaveLength(0)
    expect(status.waitingIssues).toBe(0)
    expect(status.retryQueueSize).toBe(0)
  }, 20_000)
})
