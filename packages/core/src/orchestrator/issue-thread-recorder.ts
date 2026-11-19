/**
 * Translates orchestrator runtime events into issue thread entries, so the
 * thread has one writer path and the emitters stay unaware of it.
 */

import type { InterventionContext } from "./intervention-bus"
import type { IssueThreadStore } from "./issue-thread-store"

type ThreadWriter = Pick<IssueThreadStore, "append">

const MAX_SYSTEM_TEXT = 500
const MAX_TOOL_SUMMARY = 160
/** Argument fields that say what a tool call is doing, most specific first. */
const TOOL_SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description"]

/** Record a lifecycle or activity event. Events that carry no issue key are ignored. */
export function recordThreadEvent(threads: ThreadWriter, event: string, payload: Record<string, unknown>): void {
  const issueKey = text(payload.issueKey)
  if (!issueKey) return
  const attemptId = text(payload.attemptId) || undefined

  switch (event) {
    case "agent.output":
      threads.append(issueKey, "output", text(payload.text), attemptId)
      return
    case "agent.tool":
      threads.append(issueKey, "tool", describeTool(text(payload.tool), payload.args), attemptId)
      return
    case "agent.start":
      threads.append(issueKey, "system", `Started ${text(payload.agentType) || "actor"}`, attemptId)
      return
    case "agent.done":
      threads.append(issueKey, "system", "Completed", attemptId)
      return
    case "agent.failed":
      threads.append(issueKey, "system", describeFailure(payload.error), attemptId)
      return
    case "agent.paused":
      threads.append(issueKey, "system", "Paused by operator", attemptId)
      return
    case "agent.resumed":
      threads.append(issueKey, "system", "Resumed by operator", attemptId)
      return
    case "agent.aborted":
      threads.append(
        issueKey,
        "system",
        `Aborted by operator (${text(payload.reason) || "no reason given"})`,
        attemptId,
      )
      return
  }
}

/** Record a delivered operator message, in full, plus how it reached the actor. */
export function recordOperatorMessage(
  threads: ThreadWriter,
  ctx: InterventionContext,
  message: string,
  delivery: "native" | "restart",
): void {
  if (!ctx.issueKey) return
  threads.append(ctx.issueKey, "operator", message, ctx.attemptId)
  if (delivery === "restart") {
    threads.append(
      ctx.issueKey,
      "system",
      `${ctx.agentType} cannot take a message mid-run; restarting the run with it`,
      ctx.attemptId,
    )
  } else if (READS_BETWEEN_TURNS.has(ctx.agentType)) {
    threads.append(
      ctx.issueKey,
      "system",
      `${ctx.agentType} reads messages between turns; it will answer once its current turn ends`,
      ctx.attemptId,
    )
  }
}

/** Actors whose open input queues a message behind the running turn instead of reading it inside one. */
const READS_BETWEEN_TURNS = new Set(["antigravity"])

/** `Bash: bun test` — the tool name plus the most telling argument, on one line. */
export function describeTool(tool: string, args: unknown): string {
  const name = tool || "tool"
  let summary = ""
  if (typeof args === "string") summary = args
  else if (args && typeof args === "object") {
    const record = args as Record<string, unknown>
    summary = text(TOOL_SUMMARY_KEYS.map((key) => record[key]).find((value) => typeof value === "string" && value))
  }
  summary = summary.replace(/\s+/g, " ").trim()
  if (summary.length > MAX_TOOL_SUMMARY) summary = `${summary.slice(0, MAX_TOOL_SUMMARY - 1)}…`
  return summary ? `${name}: ${summary}` : name
}

function describeFailure(error: unknown): string {
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  const message = text(detail.message).slice(0, MAX_SYSTEM_TEXT)
  const outcome = detail.retryable === true ? "Failed, will retry" : "Failed"
  return message ? `${outcome}: ${message}` : outcome
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}
