/**
 * Completion Handler tests — safety-net, delivery, and exit assessment.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ResolvedRoute } from "../config/routing"
import type { Config } from "../config/yaml-loader"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { DraftPrResult } from "../domain/ports/workspace"
import type { CompletionDeps } from "../orchestrator/completion-handler"

// The verification gate's real implementation spawns a subprocess. Mock it
// here so completion-handler tests stay deterministic and fast — the gate's
// own behavior (exec, timeout, output truncation) is covered by
// verification-gate.test.ts. `resolveVerifyCommand` / `buildVerificationFailurePrompt`
// stay real so the wiring (config -> command -> retry prompt) is exercised.
vi.mock("../orchestrator/verification-gate", async () => {
  const actual = await vi.importActual<typeof import("../orchestrator/verification-gate")>(
    "../orchestrator/verification-gate",
  )
  return { ...actual, runVerificationGate: vi.fn() }
})

const { createCompletionCallbacks } = await import("../orchestrator/completion-handler")
const { runVerificationGate } = await import("../orchestrator/verification-gate")

// ── Test fixtures ──────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "Test description",
    status: { id: "state-ip", name: "In Progress", type: "started" },
    team: { id: "team-1", key: "PROJ" },
    labels: [],
    url: "https://linear.app/proj/issue/PROJ-1",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    issueId: "issue-1",
    path: "/workspace/PROJ-1",
    key: "PROJ-1",
    branch: "feature/PROJ-1",
    status: "running",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeAttempt(overrides: Partial<RunAttempt> = {}): RunAttempt {
  return {
    id: "attempt-1",
    issueId: "issue-1",
    workspacePath: "/workspace/PROJ-1",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: null,
    exitCode: null,
    agentOutput: null,
    ...overrides,
  }
}

function makeRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    workspaceRoot: "/workspace",
    agentType: "claude",
    deliveryMode: "merge",
    matchedLabel: null,
    ...overrides,
  }
}

async function analysisWorkspace(attemptId = "attempt-1"): Promise<Workspace> {
  const path = await mkdtemp(join(tmpdir(), "av-analysis-"))
  await writeFile(join(path, `report-${attemptId}.md`), "Completed analysis with findings.", "utf8")
  return makeWorkspace({ path })
}

const analysisTask = { kind: "analysis" as const, reportPath: "report-{{attempt.id}}.md" }

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    trackerKind: "linear",
    linearApiKey: "lin_api_test",
    linearTeamId: "PROJ",
    linearTeamUuid: "team-uuid",
    linearWebhookSecret: "whsec_test",
    workflowStates: {
      todo: "state-todo",
      inProgress: "state-ip",
      done: "state-done",
      cancelled: "state-cancelled",
    },
    workspaceRoot: "/workspace",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 2,
    serverPort: 9741,
    logLevel: "info",
    logFormat: "json",
    deliveryMode: "merge",
    routingRules: [],
    promptTemplate: "test prompt",
    verify: { command: "true", timeoutSec: 600 },
    ...overrides,
  } as Config
}

// ── Fake WorkspaceGateway ──────────────────────────────────────────

function makeFakeWorkspaceGateway(
  opts: {
    hasUncommittedChanges?: boolean
    hasCodeChanges?: boolean
    diffStat?: string | null
    autoCommitOk?: boolean
    autoCommitError?: string
    autoCommitRetryable?: boolean
    autoCommitRetryPrompt?: string
    mergeOk?: boolean
    mergeError?: string
    mergeRetryable?: boolean
    mergeRetryPrompt?: string
    pushOk?: boolean
  } = {},
) {
  return {
    create: async () => makeWorkspace(),
    get: async () => null,
    detectUnfinishedWork: async () => ({
      hasUncommittedChanges: opts.hasUncommittedChanges ?? false,
      hasCodeChanges: opts.hasCodeChanges ?? false,
    }),
    autoCommit: async () => ({
      ok: opts.autoCommitOk ?? true,
      error: opts.autoCommitError,
      retryable: opts.autoCommitRetryable,
      retryPrompt: opts.autoCommitRetryPrompt,
    }),
    getDiffStat: async () => opts.diffStat ?? null,
    mergeAndPush: async () => ({
      ok: opts.mergeOk ?? true,
      error: opts.mergeError,
      retryable: opts.mergeRetryable,
      retryPrompt: opts.mergeRetryPrompt,
    }),
    pushBranch: async () => ({ ok: opts.pushOk ?? true }),
    createDraftPR: async (): Promise<DraftPrResult> => ({
      created: false,
      url: "https://github.com/example/repo/pull/1",
    }),
    cleanup: async () => {},
    saveAttempt: async () => {},
  }
}

// ── Fake IssueTracker ──────────────────────────────────────────────

function makeFakeTracker() {
  return {
    fetchIssuesByState: async () => [],
    fetchIssueLabels: async () => [],
    updateIssueState: async () => {},
    addIssueComment: async () => {},
    addIssueLabel: async () => {},
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createCompletionCallbacks", () => {
  let events: Array<{ event: string; payload: Record<string, unknown> }>
  let stateCleanups: Array<{ issueId: string; status: string }>
  let retryAdds: Array<{ issueId: string; count: number; error: string; category?: string }>
  let filledSlots: number

  function makeDeps(
    mockWm: ReturnType<typeof makeFakeWorkspaceGateway>,
    configOverrides: Partial<Config> = {},
    depsOverrides: Partial<CompletionDeps> = {},
  ): CompletionDeps {
    const deps = {
      config: makeConfig(configOverrides),
      workspace: mockWm as unknown as CompletionDeps["workspace"],
      tracker: makeFakeTracker() as unknown as CompletionDeps["tracker"],
      dagScheduler: {
        updateNodeStatus: () => {},
        getUnblockedByCompletion: () => [],
        allChildrenDone: () => false,
        getChildrenSummaries: () => [],
      } as unknown as CompletionDeps["dagScheduler"],
      cleanupState: (issueId, status) => stateCleanups.push({ issueId, status }),
      saveAttempt: () => {},
      addRetry: (issueId, count, error, category) => {
        retryAdds.push({ issueId, count, error, category })
        return count < 3
      },
      emitEvent: (event, payload) => events.push({ event, payload }),
      fillVacantSlots: async () => {
        filledSlots++
      },
      triggerUnblocked: async () => {},
      ...depsOverrides,
    } as CompletionDeps
    deps.finalizeDelivered ??= async (record) => {
      await deps.tracker.updateIssueState(record.issueId, deps.config.workflowStates.done)
      if (record.deliveryMode === "merge" && record.hasCodeChanges) await deps.workspace.cleanup(record.workspace)
      deps.cleanupState(record.issueId, "done")
      deps.emitEvent("agent.done", {
        issueKey: record.issueKey,
        issueId: record.issueId,
        attemptId: record.attemptId,
        durationMs: record.durationMs,
        autoCommitted: record.autoCommitted,
      })
      deps.dagScheduler.updateNodeStatus(record.issueId, "done")
      const unblocked = deps.dagScheduler.getUnblockedByCompletion(record.issueId)
      if (unblocked.length > 0) await deps.triggerUnblocked(unblocked)
      if (record.parentId && deps.dagScheduler.allChildrenDone(record.parentId)) {
        deps.dagScheduler.getChildrenSummaries(record.parentId)
        await deps.tracker.updateIssueState(record.parentId, deps.config.workflowStates.done)
      }
      await deps.fillVacantSlots()
    }
    return deps
  }

  beforeEach(() => {
    events = []
    stateCleanups = []
    retryAdds = []
    filledSlots = 0
    vi.mocked(runVerificationGate).mockReset()
    vi.mocked(runVerificationGate).mockResolvedValue({ ran: true, ok: true, command: "true", output: "" })
  })

  describe("onComplete — safety net", () => {
    test("auto-commits when agent leaves uncommitted changes", async () => {
      let autoCommitCalled = false
      const mockWm = makeFakeWorkspaceGateway({
        hasUncommittedChanges: true,
        hasCodeChanges: true,
        diffStat: "3 files changed, 45 insertions(+)",
        autoCommitOk: true,
      })
      const origAutoCommit = mockWm.autoCommit
      mockWm.autoCommit = async () => {
        autoCommitCalled = true
        return origAutoCommit()
      }

      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(autoCommitCalled).toBe(true)
      expect(stateCleanups[0]?.status).toBe("done")
    })

    test("does not auto-commit when no uncommitted changes", async () => {
      let autoCommitCalled = false
      const mockWm = makeFakeWorkspaceGateway({
        hasUncommittedChanges: false,
        hasCodeChanges: true,
        diffStat: "2 files changed",
      })
      mockWm.autoCommit = async () => {
        autoCommitCalled = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }

      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(autoCommitCalled).toBe(false)
    })

    test("stops completion when auto-commit is blocked by workspace validation", { timeout: 8_000 }, async () => {
      let mergeCalled = false
      const mockWm = makeFakeWorkspaceGateway({
        hasUncommittedChanges: true,
        hasCodeChanges: true,
        autoCommitOk: false,
        autoCommitError: "Conflict markers detected in changed files: package.json",
      })
      mockWm.mergeAndPush = async () => {
        mergeCalled = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }

      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(mergeCalled).toBe(false)
      expect(stateCleanups.at(-1)?.status).toBe("failed")
      expect(filledSlots).toBe(1)
      expect(events.length).toBe(0)
    })

    test("queues retry when auto-commit is blocked by regeneratable lockfiles", async () => {
      let mergeCalled = false
      const mockWm = makeFakeWorkspaceGateway({
        hasUncommittedChanges: true,
        hasCodeChanges: true,
        autoCommitOk: false,
        autoCommitError: "Conflict markers detected in regeneratable lockfiles: package-lock.json",
        autoCommitRetryable: true,
        autoCommitRetryPrompt: "Run npm install to regenerate package-lock.json",
      })
      mockWm.mergeAndPush = async () => {
        mergeCalled = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }

      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(mergeCalled).toBe(false)
      expect(stateCleanups.at(-1)?.status).toBe("failed")
      expect(retryAdds.at(-1)?.error).toContain("Run npm install")
      expect(filledSlots).toBe(1)
      expect(events.length).toBe(0)
    })
  })

  describe("onComplete — exit assessment", () => {
    test("transitions to Done when code changes exist", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Implemented feature",
      })

      // agent.done event emitted
      expect(events.some((e) => e.event === "agent.done")).toBe(true)
      expect(filledSlots).toBe(1)
    })

    test("rejects text-only output without code changes", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "No changes needed — the feature already exists",
      })

      expect(events.some((e) => e.event === "agent.done")).toBe(false)
      expect(retryAdds.at(-1)?.category).toBe("capability")
    })

    test("schedules retry when no changes and no output (anti-premature-exit)", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      let retryAdded = false
      const deps = makeDeps(mockWm)
      const origAddRetry = deps.addRetry
      deps.addRetry = (...args: Parameters<typeof origAddRetry>) => {
        retryAdded = true
        return origAddRetry(...args)
      }
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: null,
      })

      expect(retryAdded).toBe(true)
    })

    test("schedules retry when output is whitespace-only", { timeout: 10_000 }, async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      let retryAdded = false
      const deps = makeDeps(mockWm)
      const origAddRetry = deps.addRetry
      deps.addRetry = (...args: Parameters<typeof origAddRetry>) => {
        retryAdded = true
        return origAddRetry(...args)
      }
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "   \n  ",
      })

      expect(retryAdded).toBe(true)
    })
  })

  describe("onComplete — delivery mode", () => {
    test("merge mode calls mergeAndPush + cleanup", async () => {
      let merged = false
      let cleaned = false
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      mockWm.mergeAndPush = async () => {
        merged = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }
      mockWm.cleanup = async () => {
        cleaned = true
      }

      const deps = makeDeps(mockWm)
      const route = makeRoute({ deliveryMode: "merge" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(merged).toBe(true)
      expect(cleaned).toBe(true)
    })

    test("merge mode queues retry for regeneratable lockfile conflicts", async () => {
      let cleaned = false
      const mockWm = makeFakeWorkspaceGateway({
        hasCodeChanges: true,
        diffStat: "1 file",
        mergeOk: false,
        mergeError: "Rebase conflicted in regeneratable lockfiles: package-lock.json",
        mergeRetryable: true,
        mergeRetryPrompt: "Run npm install to regenerate package-lock.json",
      })
      mockWm.cleanup = async () => {
        cleaned = true
      }

      const deps = makeDeps(mockWm)
      const route = makeRoute({ deliveryMode: "merge" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(cleaned).toBe(false)
      expect(stateCleanups.at(-1)?.status).toBe("failed")
      expect(retryAdds.at(-1)?.error).toContain("Run npm install")
      expect(events.length).toBe(0)
    })

    test("pr mode pushes branch when code changes exist", async () => {
      let pushed = false
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", pushOk: true })
      mockWm.pushBranch = async () => {
        pushed = true
        return { ok: true }
      }

      const deps = makeDeps(mockWm)
      const route = makeRoute({ deliveryMode: "pr" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(pushed).toBe(true)
    })

    test("pr mode skips push when no code changes", async () => {
      let pushed = false
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      mockWm.pushBranch = async () => {
        pushed = true
        return { ok: true }
      }

      const deps = makeDeps(mockWm)
      const route = makeRoute({ deliveryMode: "pr" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: null,
      })

      expect(pushed).toBe(false)
    })
  })

  describe("onComplete — verification gate", () => {
    test("no verify_command configured blocks delivery and Done", async () => {
      let merged = false
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      mockWm.mergeAndPush = async () => {
        merged = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }
      const deps = makeDeps(mockWm, { verify: { command: undefined, timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(runVerificationGate).not.toHaveBeenCalled()
      expect(merged).toBe(false)
      expect(events.some((e) => e.event === "agent.done")).toBe(false)
      expect(retryAdds.at(-1)?.category).toBe("verification")
    })

    test("gate passes — merge proceeds and issue transitions to Done", async () => {
      let merged = false
      vi.mocked(runVerificationGate).mockResolvedValue({ ran: true, ok: true, command: "bun test", output: "PASS" })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      mockWm.mergeAndPush = async () => {
        merged = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }
      const deps = makeDeps(mockWm, { verify: { command: "bun test", timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(runVerificationGate).toHaveBeenCalledTimes(1)
      expect(merged).toBe(true)
      expect(events.some((e) => e.event === "agent.done")).toBe(true)
    })

    test("gate fails — no merge, not Done, retry scheduled with failure output as context", async () => {
      let merged = false
      vi.mocked(runVerificationGate).mockResolvedValue({
        ran: true,
        ok: false,
        command: "bun test",
        output: "FAIL: expected 1 to equal 2",
        timedOut: false,
      })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      mockWm.mergeAndPush = async () => {
        merged = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }
      const deps = makeDeps(mockWm, { verify: { command: "bun test", timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(merged).toBe(false)
      expect(events.length).toBe(0) // no agent.done emitted — Done transition never reached
      expect(stateCleanups.at(-1)?.status).toBe("failed")
      expect(retryAdds).toHaveLength(1)
      expect(retryAdds[0]?.error).toContain("FAIL: expected 1 to equal 2")
      expect(retryAdds[0]?.error).toContain("Retry instruction:")
      expect(filledSlots).toBe(1)
    })

    test("gate fails on a timeout — retry prompt uses the timeout header", async () => {
      vi.mocked(runVerificationGate).mockResolvedValue({
        ran: true,
        ok: false,
        command: "bun test",
        output: "",
        timedOut: true,
      })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      const deps = makeDeps(mockWm, { verify: { command: "bun test", timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(retryAdds[0]?.error).toContain("Verification command timed out: bun test")
    })

    test("gate fails and retries are exhausted — issue is cancelled, not merged, not Done", async () => {
      let merged = false
      vi.mocked(runVerificationGate).mockResolvedValue({
        ran: true,
        ok: false,
        command: "bun test",
        output: "FAIL",
        timedOut: false,
      })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      mockWm.mergeAndPush = async () => {
        merged = true
        return { ok: true, error: undefined, retryable: undefined, retryPrompt: undefined }
      }
      let cancelledState: string | null = null
      const deps = makeDeps(
        mockWm,
        { verify: { command: "bun test", timeoutSec: 600 } },
        {
          addRetry: () => false, // simulate max retries already exceeded
          tracker: {
            fetchIssuesByState: async () => [],
            fetchIssueLabels: async () => [],
            addIssueComment: async () => {},
            addIssueLabel: async () => {},
            updateIssueState: async (_issueId: string, state: string) => {
              cancelledState = state
            },
          } as unknown as CompletionDeps["tracker"],
        },
      )
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(merged).toBe(false)
      expect(cancelledState).toBe(deps.config.workflowStates.cancelled)
      expect(events.length).toBe(0)
    })

    test("gate only runs when there are code changes", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const deps = makeDeps(mockWm, { verify: { command: "bun test", timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "No changes needed",
      })

      expect(runVerificationGate).not.toHaveBeenCalled()
    })

    test("per-route verify_command is preferred over the project-wide command", async () => {
      vi.mocked(runVerificationGate).mockResolvedValue({ ran: true, ok: true, command: "pytest", output: "" })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      const deps = makeDeps(mockWm, {
        verify: { command: "bun test", timeoutSec: 600 },
        routingRules: [{ label: "scope:backend", workspaceRoot: "/repo", verifyCommand: "pytest" }],
      })
      const route = makeRoute({ matchedLabel: "scope:backend" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(runVerificationGate).toHaveBeenCalledWith(expect.anything(), "pytest", expect.anything())
    })
  })

  describe("onComplete — DAG cascade", () => {
    function makeCompletedAttempt() {
      return {
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      }
    }

    test("calls dagScheduler.updateNodeStatus with done", async () => {
      const dagCalls: string[] = []
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const deps = makeDeps(
        mockWm,
        {},
        {
          dagScheduler: {
            updateNodeStatus: (id: string, status: string) => dagCalls.push(`${id}:${status}`),
            getUnblockedByCompletion: () => [],
            allChildrenDone: () => false,
            getChildrenSummaries: () => [],
          } as unknown as CompletionDeps["dagScheduler"],
        },
      )
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeCompletedAttempt())

      expect(dagCalls).toContain("issue-1:done")
    })

    test("triggers unblocked issues when getUnblockedByCompletion returns IDs", async () => {
      const triggeredIds: string[][] = []
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const deps = makeDeps(
        mockWm,
        {},
        {
          dagScheduler: {
            updateNodeStatus: () => {},
            getUnblockedByCompletion: () => ["issue-2", "issue-3"],
            allChildrenDone: () => false,
            getChildrenSummaries: () => [],
          } as unknown as CompletionDeps["dagScheduler"],
          triggerUnblocked: async (ids: string[]) => {
            triggeredIds.push(ids)
          },
        },
      )
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeCompletedAttempt())

      expect(triggeredIds.length).toBe(1)
      expect(triggeredIds[0]).toEqual(["issue-2", "issue-3"])
    })

    test("does not trigger when no issues unblocked", async () => {
      const triggeredIds: string[][] = []
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const deps = makeDeps(
        mockWm,
        {},
        {
          dagScheduler: {
            updateNodeStatus: () => {},
            getUnblockedByCompletion: () => [],
            allChildrenDone: () => false,
            getChildrenSummaries: () => [],
          } as unknown as CompletionDeps["dagScheduler"],
          triggerUnblocked: async (ids: string[]) => {
            triggeredIds.push(ids)
          },
        },
      )
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeCompletedAttempt())

      expect(triggeredIds.length).toBe(0)
    })

    test("auto-completes parent when allChildrenDone returns true", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const issue = makeIssue({ parentId: "parent-1" })
      let allChildrenDoneCalled = false
      let getChildrenSummariesCalled = false
      const deps = makeDeps(
        mockWm,
        {},
        {
          dagScheduler: {
            updateNodeStatus: () => {},
            getUnblockedByCompletion: () => [],
            allChildrenDone: (parentId: string) => {
              allChildrenDoneCalled = parentId === "parent-1"
              return true
            },
            getChildrenSummaries: (parentId: string) => {
              getChildrenSummariesCalled = parentId === "parent-1"
              return []
            },
          } as unknown as CompletionDeps["dagScheduler"],
        },
      )
      const callbacks = createCompletionCallbacks(deps, issue, makeWorkspace(), makeAttempt(), makeRoute())

      // The Linear API calls inside the auto-complete block will fail (no real API),
      // but errors are caught and logged — the flow must complete without throwing.
      await expect(callbacks.onComplete(makeCompletedAttempt())).resolves.toBeUndefined()

      expect(allChildrenDoneCalled).toBe(true)
      expect(getChildrenSummariesCalled).toBe(true)
    })

    test("does not auto-complete parent when allChildrenDone returns false", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file changed" })
      const issue = makeIssue({ parentId: "parent-1" })
      let getChildrenSummariesCalled = false
      const deps = makeDeps(
        mockWm,
        {},
        {
          dagScheduler: {
            updateNodeStatus: () => {},
            getUnblockedByCompletion: () => [],
            allChildrenDone: () => false,
            getChildrenSummaries: () => {
              getChildrenSummariesCalled = true
              return []
            },
          } as unknown as CompletionDeps["dagScheduler"],
        },
      )
      const callbacks = createCompletionCallbacks(deps, issue, makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeCompletedAttempt())

      expect(getChildrenSummariesCalled).toBe(false)
    })
  })

  describe("onError", () => {
    test("cleans up state and emits agent.failed", async () => {
      const mockWm = makeFakeWorkspaceGateway()
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({ code: "CRASH", message: "process died", recoverable: true })

      expect(stateCleanups[0]).toEqual({ issueId: "issue-1", status: "failed" })
      expect(events[0]?.event).toBe("agent.failed")
      expect(retryAdds.length).toBe(1)
      expect(filledSlots).toBe(1)
    })

    test("non-recoverable error does not queue retry", async () => {
      const mockWm = makeFakeWorkspaceGateway()
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({ code: "FATAL", message: "unrecoverable", recoverable: false })

      expect(retryAdds.length).toBe(0)
    })
  })

  describe("retry failure classification", () => {
    test("auto-commit blocked by lockfile conflict classifies as 'infra'", async () => {
      const mockWm = makeFakeWorkspaceGateway({
        hasUncommittedChanges: true,
        hasCodeChanges: true,
        autoCommitOk: false,
        autoCommitError: "Conflict markers detected in regeneratable lockfiles: package-lock.json",
        autoCommitRetryable: true,
        autoCommitRetryPrompt: "Run npm install to regenerate package-lock.json",
      })
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(retryAdds.at(-1)?.category).toBe("infra")
    })

    test("verification gate failure classifies as 'verification'", async () => {
      vi.mocked(runVerificationGate).mockResolvedValue({
        ran: true,
        ok: false,
        command: "bun test",
        output: "FAIL",
        timedOut: false,
      })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
      const deps = makeDeps(mockWm, { verify: { command: "bun test", timeoutSec: 600 } })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(retryAdds.at(-1)?.category).toBe("verification")
    })

    test("merge lockfile conflict classifies as 'infra'", async () => {
      const mockWm = makeFakeWorkspaceGateway({
        hasCodeChanges: true,
        diffStat: "1 file",
        mergeOk: false,
        mergeError: "Rebase conflicted in regeneratable lockfiles: package-lock.json",
        mergeRetryable: true,
        mergeRetryPrompt: "Run npm install to regenerate package-lock.json",
      })
      const deps = makeDeps(mockWm)
      const route = makeRoute({ deliveryMode: "merge" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), route)

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
      })

      expect(retryAdds.at(-1)?.category).toBe("infra")
    })

    test("premature-exit (no code changes, no output) classifies as 'capability'", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: null,
      })

      expect(retryAdds.at(-1)?.category).toBe("capability")
    })

    test("recoverable agent onError classifies as 'infra'", async () => {
      const mockWm = makeFakeWorkspaceGateway()
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({ code: "TIMEOUT", message: "agent timed out", recoverable: true })

      expect(retryAdds.at(-1)?.category).toBe("infra")
    })
  })

  describe("onComplete — budget recordUsage wiring", () => {
    function makeRecordingBudget(overrides: Partial<import("../orchestrator/budget-service").BudgetService> = {}) {
      const calls: Array<{ attemptId: string; issueId: string; usage: unknown }> = []
      const budget: import("../orchestrator/budget-service").BudgetService = {
        checkBeforeSpawn: async () => ({ allow: true }),
        recordUsage: async (attemptId, issueId, usage) => {
          calls.push({ attemptId, issueId, usage })
        },
        getDailyUsed: () => ({ tokens: 0, usd: 0 }),
        getIssueUsed: () => ({ tokens: 0, usd: 0 }),
        ...overrides,
      }
      return { budget, calls }
    }

    test("forwards tokenUsage to BudgetService.recordUsage on onComplete", async () => {
      const { budget, calls } = makeRecordingBudget()
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file" })
      const deps = makeDeps(mockWm, {}, { budget })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
        tokenUsage: { input: 1200, output: 340, model: "claude-sonnet-4.5" },
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        attemptId: "attempt-1",
        issueId: "issue-1",
        usage: { input: 1200, output: 340, model: "claude-sonnet-4.5" },
      })
    })

    test("skips recordUsage when tokenUsage is absent (e.g. gemini CLI fallback)", async () => {
      const { budget, calls } = makeRecordingBudget()
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file" })
      const deps = makeDeps(mockWm, {}, { budget })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Done",
        // tokenUsage intentionally omitted
      })

      expect(calls).toHaveLength(0)
    })

    test("swallows recordUsage failures — completion pipeline continues", async () => {
      const { budget } = makeRecordingBudget({
        recordUsage: async () => {
          throw new Error("boom")
        },
      })
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file" })
      const deps = makeDeps(mockWm, {}, { budget })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await expect(
        callbacks.onComplete({
          ...makeAttempt(),
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          agentOutput: "Done",
          tokenUsage: { input: 50, output: 10, model: "claude-sonnet-4.5" },
        }),
      ).resolves.toBeUndefined()

      // agent.done still emitted and DAG cascade path ran
      expect(events.some((e) => e.event === "agent.done")).toBe(true)
      expect(filledSlots).toBe(1)
    })

    test("no-op when budget is not wired on deps", async () => {
      const mockWm = makeFakeWorkspaceGateway({ hasCodeChanges: true, diffStat: "1 file" })
      const deps = makeDeps(mockWm) // no budget
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await expect(
        callbacks.onComplete({
          ...makeAttempt(),
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          agentOutput: "Done",
          tokenUsage: { input: 1, output: 1, model: "claude" },
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe("terminal outcome and delivery regressions", () => {
    const completed = () =>
      makeAttempt({
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "Implemented change",
        tokenUsage: { input: 10, output: 5, model: "test-model" },
      })

    function terminalDeps(mockWm: ReturnType<typeof makeFakeWorkspaceGateway>) {
      const tracker = makeFakeTracker() as CompletionDeps["tracker"]
      const states: string[] = []
      const dagStatuses: string[] = []
      const budgetCalls: string[] = []
      tracker.updateIssueState = async (_id: string, state: string) => {
        states.push(state)
      }
      const deps = makeDeps(
        mockWm,
        {},
        {
          tracker: tracker as CompletionDeps["tracker"],
          dagScheduler: {
            updateNodeStatus: (_id: string, status: string) => {
              dagStatuses.push(status)
            },
            getUnblockedByCompletion: () => [],
            allChildrenDone: () => false,
            getChildrenSummaries: () => [],
          } as unknown as CompletionDeps["dagScheduler"],
          budget: {
            checkBeforeSpawn: async () => ({ allow: true }),
            recordUsage: async (id: string) => {
              budgetCalls.push(id)
            },
            getDailyUsed: () => ({ tokens: 0, usd: 0 }),
            getIssueUsed: () => ({ tokens: 0, usd: 0 }),
          },
        },
      )
      return { deps, tracker, states, dagStatuses, budgetCalls }
    }

    test("failed branch push blocks Done and does not create a PR", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true, pushOk: false })
      const pr = vi.fn(gateway.createDraftPR)
      gateway.createDraftPR = pr
      const { deps, states, dagStatuses, budgetCalls } = terminalDeps(gateway)
      const callbacks = createCompletionCallbacks(
        deps,
        makeIssue(),
        makeWorkspace(),
        makeAttempt(),
        makeRoute({ deliveryMode: "pr" }),
      )

      await callbacks.onComplete(completed())

      expect(pr).not.toHaveBeenCalled()
      expect(states).toEqual(["state-cancelled"])
      expect(dagStatuses).toEqual(["cancelled"])
      expect(events.some((e) => e.event === "agent.done")).toBe(false)
      expect(stateCleanups).toEqual([{ issueId: "issue-1", status: "failed" }])
      expect(budgetCalls).toEqual(["attempt-1"])
    })

    test("missing PR URL blocks Done after a successful push without replaying push", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true })
      const push = vi.fn(gateway.pushBranch)
      gateway.pushBranch = push
      gateway.createDraftPR = async () => ({ created: false })
      const { deps, states, dagStatuses } = terminalDeps(gateway)
      const callbacks = createCompletionCallbacks(
        deps,
        makeIssue(),
        makeWorkspace(),
        makeAttempt(),
        makeRoute({ deliveryMode: "pr" }),
      )

      await callbacks.onComplete(completed())

      expect(push).toHaveBeenCalledTimes(1)
      expect(states).toEqual(["state-cancelled"])
      expect(dagStatuses).toEqual(["cancelled"])
      expect(events.some((e) => e.event === "agent.done")).toBe(false)
    })

    test("thrown PR creation retries only PR creation and accepts an existing URL", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true })
      const push = vi.fn(gateway.pushBranch)
      gateway.pushBranch = push
      const pr = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary gh failure"))
        .mockResolvedValueOnce({ created: false, url: "https://github.com/example/repo/pull/2" })
      gateway.createDraftPR = pr
      const { deps, states, dagStatuses } = terminalDeps(gateway)
      const callbacks = createCompletionCallbacks(
        deps,
        makeIssue(),
        makeWorkspace(),
        makeAttempt(),
        makeRoute({ deliveryMode: "pr" }),
      )

      await callbacks.onComplete(completed())

      expect(push).toHaveBeenCalledTimes(1)
      expect(pr).toHaveBeenCalledTimes(2)
      expect(states).toEqual(["state-done"])
      expect(dagStatuses).toEqual(["done"])
    })

    test("thrown branch push retries the push step before creating a PR", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true })
      const push = vi.fn().mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce({ ok: true })
      gateway.pushBranch = push
      const pr = vi.fn(gateway.createDraftPR)
      gateway.createDraftPR = pr
      const { deps, states } = terminalDeps(gateway)
      const callbacks = createCompletionCallbacks(
        deps,
        makeIssue(),
        makeWorkspace(),
        makeAttempt(),
        makeRoute({ deliveryMode: "pr" }),
      )

      await callbacks.onComplete(completed())

      expect(push).toHaveBeenCalledTimes(2)
      expect(pr).toHaveBeenCalledTimes(1)
      expect(states).toEqual(["state-done"])
    })

    test("an explicit assessment can reject text-only output without blocking analysis reports", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ task: analysisTask })
      deps.assessNoCodeOutcome = async (_issue, completedAttempt) =>
        completedAttempt.agentOutput === "Analysis complete: no code change required"
      const workspace = await analysisWorkspace()
      const callbacks = createCompletionCallbacks(deps, makeIssue(), workspace, makeAttempt(), makeRoute())

      await callbacks.onComplete(
        makeAttempt({ ...completed(), agentOutput: "Analysis complete: no code change required" }),
      )

      expect(states).toEqual(["state-done"])
      const promised = createCompletionCallbacks(
        deps,
        makeIssue(),
        workspace,
        makeAttempt({ id: "attempt-2" }),
        makeRoute(),
      )
      await promised.onComplete(
        makeAttempt({ ...completed(), id: "attempt-2", agentOutput: "I will investigate this bug." }),
      )
      expect(states).toEqual(["state-done"])
      expect(retryAdds.at(-1)?.category).toBe("capability")
    })

    test("strict OMA evidence rejects a text-only promise before delivery", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "strict" } })
      deps.omaEvidence = async () => ({ ok: false, reason: "no bound receipt" })
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeAttempt({ ...completed(), agentOutput: "I will investigate this bug." }))

      expect(states).toEqual([])
      expect(events.some((event) => event.event === "agent.done")).toBe(false)
      expect(retryAdds.at(-1)?.category).toBe("capability")
    })

    test("strict OMA evidence validates before auto-commit and accepts a report-backed analysis", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "strict" }, task: analysisTask })
      deps.omaEvidence = async (request) => {
        expect(request.reportPath).toBe(analysisTask.reportPath)
        return { ok: true, runId: "current-run" }
      }
      const callbacks = createCompletionCallbacks(
        deps,
        makeIssue(),
        await analysisWorkspace(),
        makeAttempt(),
        makeRoute(),
      )

      await callbacks.onComplete(makeAttempt({ ...completed(), agentOutput: null }))

      expect(states).toEqual(["state-done"])
      expect(events.some((event) => event.event === "agent.done")).toBe(true)
    })

    test("strict OMA mode leaves uncommitted work untouched so receipts stay current", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true, hasUncommittedChanges: true })
      const autoCommit = vi.fn(gateway.autoCommit)
      gateway.autoCommit = autoCommit
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "strict" } })
      const evidence = vi.fn().mockResolvedValue({ ok: true })
      deps.omaEvidence = evidence
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(completed())

      expect(autoCommit).not.toHaveBeenCalled()
      expect(evidence).not.toHaveBeenCalled()
      expect(states).toEqual([])
    })

    test("strict OMA mode uses its pinned check receipt without rerunning the command", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true })
      const { deps, states, budgetCalls } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "strict" }, verify: { command: "npm test", timeoutSec: 600 } })
      const saved = vi.fn()
      deps.saveAttempt = saved
      deps.omaEvidence = async () => {
        expect(budgetCalls).toEqual([])
        expect(saved).not.toHaveBeenCalled()
        return { ok: true, runId: "current-run" }
      }
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(completed())

      expect(runVerificationGate).not.toHaveBeenCalled()
      expect(budgetCalls).toEqual(["attempt-1"])
      expect(saved).toHaveBeenCalledTimes(1)
      expect(states).toEqual(["state-done"])
    })

    test("OMA-off mode rejects a promise without an explicitly configured analysis artifact", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "off" } })
      const evidence = vi.fn().mockResolvedValue({ ok: false })
      deps.omaEvidence = evidence
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(
        makeAttempt({ ...completed(), agentOutput: "Analysis complete: no code change required" }),
      )

      expect(evidence).not.toHaveBeenCalled()
      expect(states).toEqual([])
      expect(retryAdds.at(-1)?.category).toBe("capability")
    })

    test("OMA-off explicit analysis completes with a current report from this attempt", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states } = terminalDeps(gateway)
      deps.config = makeConfig({ oma: { mode: "off" }, task: analysisTask })
      const workspace = await analysisWorkspace()
      const callbacks = createCompletionCallbacks(deps, makeIssue(), workspace, makeAttempt(), makeRoute())

      await callbacks.onComplete(makeAttempt({ ...completed(), agentOutput: null }))

      expect(states).toEqual(["state-done"])
      expect(events.filter((event) => event.event === "agent.done")).toHaveLength(1)
    })

    test("records known usage once while tracker finalization remains pending", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true })
      const { deps, budgetCalls } = terminalDeps(gateway)
      const pending = vi.fn(async () => {})
      deps.finalizeDelivered = pending
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(completed())
      await callbacks.onComplete(completed())

      expect(budgetCalls).toEqual(["attempt-1"])
      expect(pending).toHaveBeenCalledTimes(1)
      expect(events.some((event) => event.event === "agent.done")).toBe(false)
    })

    test("retry-exhausted no-op cancels without success cascade", async () => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: false })
      const { deps, states, dagStatuses, budgetCalls } = terminalDeps(gateway)
      deps.addRetry = () => false
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete(makeAttempt({ ...completed(), agentOutput: null }))

      expect(states).toEqual(["state-cancelled"])
      expect(dagStatuses).toEqual(["cancelled"])
      expect(events.some((e) => e.event === "agent.done")).toBe(false)
      expect(budgetCalls).toEqual(["attempt-1"])
    })

    test.each(["verification", "merge"])("records usage once when %s fails before Done", async (failure) => {
      const gateway = makeFakeWorkspaceGateway({ hasCodeChanges: true, mergeOk: failure !== "merge" })
      if (failure === "verification") {
        vi.mocked(runVerificationGate).mockResolvedValue({ ran: true, ok: false, command: "false", output: "failed" })
      }
      const { deps, budgetCalls } = terminalDeps(gateway)
      const config = failure === "verification" ? { verify: { command: "false", timeoutSec: 5 } } : {}
      const callbacks = createCompletionCallbacks(
        { ...deps, config: makeConfig(config) },
        makeIssue(),
        makeWorkspace(),
        makeAttempt(),
        makeRoute(),
      )

      await callbacks.onComplete(completed())

      expect(budgetCalls).toEqual(["attempt-1"])
      expect(events.some((e) => e.event === "agent.done")).toBe(false)
    })

    test("error callback records known usage once", async () => {
      const gateway = makeFakeWorkspaceGateway()
      const { deps, budgetCalls } = terminalDeps(gateway)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({
        code: "CANCELLED",
        message: "interrupted",
        recoverable: false,
        tokenUsage: { input: 7, output: 3, model: "test-model" },
      })
      await callbacks.onError({
        code: "CANCELLED",
        message: "duplicate",
        recoverable: false,
        tokenUsage: { input: 7, output: 3, model: "test-model" },
      })

      expect(budgetCalls).toEqual(["attempt-1"])
      expect(stateCleanups).toEqual([{ issueId: "issue-1", status: "failed" }])
    })
  })
})
