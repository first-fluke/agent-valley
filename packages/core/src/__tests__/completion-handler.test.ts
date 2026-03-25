/**
 * Completion Handler tests — safety-net, delivery, and exit assessment.
 */
import { beforeEach, describe, expect, test } from "vitest"
import type { Config } from "../config/env"
import type { ResolvedRoute } from "../config/routing"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { type CompletionDeps, createCompletionCallbacks } from "../orchestrator/completion-handler"

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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
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
    ...overrides,
  } as Config
}

// ── Mock workspace manager ─────────────────────────────────────────

function makeMockWorkspaceManager(
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
    cleanup: async () => {},
    saveAttempt: async () => {},
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createCompletionCallbacks", () => {
  let events: Array<{ event: string; payload: Record<string, unknown> }>
  let stateCleanups: Array<{ issueId: string; status: string }>
  let retryAdds: Array<{ issueId: string; count: number; error: string }>
  let filledSlots: number

  function makeDeps(
    mockWm: ReturnType<typeof makeMockWorkspaceManager>,
    configOverrides: Partial<Config> = {},
    depsOverrides: Partial<CompletionDeps> = {},
  ): CompletionDeps {
    return {
      config: makeConfig(configOverrides),
      workspaceManager: mockWm as unknown as CompletionDeps["workspaceManager"],
      dagScheduler: {
        updateNodeStatus: () => {},
        getUnblockedByCompletion: () => [],
        allChildrenDone: () => false,
        getChildrenSummaries: () => [],
      } as unknown as CompletionDeps["dagScheduler"],
      cleanupState: (issueId, status) => stateCleanups.push({ issueId, status }),
      saveAttempt: () => {},
      addRetry: (issueId, count, error) => {
        retryAdds.push({ issueId, count, error })
        return count < 3
      },
      emitEvent: (event, payload) => events.push({ event, payload }),
      fillVacantSlots: async () => {
        filledSlots++
      },
      triggerUnblocked: async () => {},
      ...depsOverrides,
    }
  }

  beforeEach(() => {
    events = []
    stateCleanups = []
    retryAdds = []
    filledSlots = 0
  })

  describe("onComplete — safety net", () => {
    test("auto-commits when agent leaves uncommitted changes", async () => {
      let autoCommitCalled = false
      const mockWm = makeMockWorkspaceManager({
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
      const mockWm = makeMockWorkspaceManager({
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
      const mockWm = makeMockWorkspaceManager({
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
      const mockWm = makeMockWorkspaceManager({
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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

    test("transitions to Done when no changes but has output", async () => {
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: false })
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onComplete({
        ...makeAttempt(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        agentOutput: "No changes needed — the feature already exists",
      })

      expect(events.some((e) => e.event === "agent.done")).toBe(true)
    })

    test("schedules retry when no changes and no output (anti-premature-exit)", async () => {
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: false })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: false })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file", mergeOk: true })
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
      const mockWm = makeMockWorkspaceManager({
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file", pushOk: true })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: false })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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
      const mockWm = makeMockWorkspaceManager({ hasCodeChanges: true, diffStat: "1 file changed" })
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
      const mockWm = makeMockWorkspaceManager()
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({ code: "CRASH", message: "process died", recoverable: true })

      expect(stateCleanups[0]).toEqual({ issueId: "issue-1", status: "failed" })
      expect(events[0]?.event).toBe("agent.failed")
      expect(retryAdds.length).toBe(1)
      expect(filledSlots).toBe(1)
    })

    test("non-recoverable error does not queue retry", async () => {
      const mockWm = makeMockWorkspaceManager()
      const deps = makeDeps(mockWm)
      const callbacks = createCompletionCallbacks(deps, makeIssue(), makeWorkspace(), makeAttempt(), makeRoute())

      await callbacks.onError({ code: "FATAL", message: "unrecoverable", recoverable: false })

      expect(retryAdds.length).toBe(0)
    })
  })
})
