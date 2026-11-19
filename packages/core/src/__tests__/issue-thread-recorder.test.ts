import { describe, expect, test } from "vitest"
import { describeTool, recordOperatorMessage, recordThreadEvent } from "../orchestrator/issue-thread-recorder"
import { IssueThreadStore } from "../orchestrator/issue-thread-store"

function recorded(store: IssueThreadStore, issueKey = "AV-1") {
  return store.read(issueKey).map(({ kind, text, attemptId }) => ({ kind, text, attemptId }))
}

describe("recordThreadEvent", () => {
  test("mirrors a run's lifecycle and activity into the issue thread", () => {
    const store = new IssueThreadStore()
    const activity = { issueKey: "AV-1", issueId: "id-1", attemptId: "att-1" }

    recordThreadEvent(store, "agent.start", { issueKey: "AV-1", issueId: "id-1", agentType: "codex" })
    recordThreadEvent(store, "agent.tool", { ...activity, tool: "Bash", args: { command: "bun test" } })
    recordThreadEvent(store, "agent.output", { ...activity, text: "All tests pass" })
    recordThreadEvent(store, "agent.paused", { ...activity, agentType: "codex", at: "t" })
    recordThreadEvent(store, "agent.resumed", { ...activity, agentType: "codex", at: "t" })
    recordThreadEvent(store, "agent.done", activity)

    expect(recorded(store)).toEqual([
      { kind: "system", text: "Started codex", attemptId: undefined },
      { kind: "tool", text: "Bash: bun test", attemptId: "att-1" },
      { kind: "output", text: "All tests pass", attemptId: "att-1" },
      { kind: "system", text: "Paused by operator", attemptId: "att-1" },
      { kind: "system", text: "Resumed by operator", attemptId: "att-1" },
      { kind: "system", text: "Completed", attemptId: "att-1" },
    ])
  })

  test("says whether a failure will be retried and why an abort happened", () => {
    const store = new IssueThreadStore()
    recordThreadEvent(store, "agent.failed", {
      issueKey: "AV-1",
      error: { code: "TIMEOUT", message: "Agent timed out after 60s", retryable: true },
    })
    recordThreadEvent(store, "agent.failed", { issueKey: "AV-1", error: { message: "exit 1", retryable: false } })
    recordThreadEvent(store, "agent.failed", { issueKey: "AV-1" })
    recordThreadEvent(store, "agent.aborted", { issueKey: "AV-1", attemptId: "att-1", reason: "wrong branch" })
    recordThreadEvent(store, "agent.aborted", { issueKey: "AV-1", attemptId: "att-1" })

    expect(recorded(store).map((entry) => entry.text)).toEqual([
      "Failed, will retry: Agent timed out after 60s",
      "Failed: exit 1",
      "Failed",
      "Aborted by operator (wrong branch)",
      "Aborted by operator (no reason given)",
    ])
  })

  test("ignores events without an issue key and events the thread does not show", () => {
    const store = new IssueThreadStore()
    recordThreadEvent(store, "agent.output", { attemptId: "att-1", text: "nowhere to file this" })
    recordThreadEvent(store, "node.join", { issueKey: "AV-1" })
    recordThreadEvent(store, "agent.start", { issueKey: "AV-1" })

    expect(recorded(store)).toEqual([{ kind: "system", text: "Started actor", attemptId: undefined }])
  })
})

describe("recordOperatorMessage", () => {
  const ctx = { attemptId: "att-1", issueKey: "AV-1", agentType: "claude", at: "t" }

  test("records a natively delivered message as a single operator entry", () => {
    const store = new IssueThreadStore()
    recordOperatorMessage(store, { ...ctx, agentType: "codex" }, "also update README", "native")
    expect(recorded(store)).toEqual([{ kind: "operator", text: "also update README", attemptId: "att-1" }])
  })

  test("explains the restart when the agent cannot take a message mid-run", () => {
    const store = new IssueThreadStore()
    recordOperatorMessage(store, ctx, "add tests", "restart")
    expect(recorded(store)).toEqual([
      { kind: "operator", text: "add tests", attemptId: "att-1" },
      {
        kind: "system",
        text: "claude cannot take a message mid-run; restarting the run with it",
        attemptId: "att-1",
      },
    ])
  })

  test("says when the agent will only read the message after its current turn", () => {
    const store = new IssueThreadStore()
    recordOperatorMessage(store, { ...ctx, agentType: "antigravity" }, "add tests", "native")
    expect(recorded(store)).toEqual([
      { kind: "operator", text: "add tests", attemptId: "att-1" },
      {
        kind: "system",
        text: "antigravity reads messages between turns; it will answer once its current turn ends",
        attemptId: "att-1",
      },
    ])
  })

  test("drops a message whose attempt has no issue key", () => {
    const store = new IssueThreadStore()
    recordOperatorMessage(store, { ...ctx, issueKey: undefined }, "lost", "native")
    expect(store.read("AV-1")).toEqual([])
  })
})

describe("describeTool", () => {
  test("picks the most telling argument and flattens it to one line", () => {
    expect(describeTool("Bash", { description: "run tests", command: "bun test\n  --coverage" })).toBe(
      "Bash: bun test --coverage",
    )
    expect(describeTool("Read", { file_path: "src/a.ts" })).toBe("Read: src/a.ts")
    expect(describeTool("shell", "ls -la")).toBe("shell: ls -la")
  })

  test("falls back to the bare name when no argument is informative", () => {
    expect(describeTool("TodoWrite", { todos: [{ id: 1 }] })).toBe("TodoWrite")
    expect(describeTool("Bash", null)).toBe("Bash")
    expect(describeTool("", undefined)).toBe("tool")
  })

  test("truncates a long argument", () => {
    const described = describeTool("Bash", { command: "x".repeat(400) })
    expect(described.length).toBeLessThanOrEqual("Bash: ".length + 160)
    expect(described.endsWith("…")).toBe(true)
  })
})
