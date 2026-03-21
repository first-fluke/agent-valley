/**
 * Orchestrator Helpers — Pure functions extracted to keep orchestrator.ts under 500 lines.
 */

import type { Issue, RunAttempt } from "../domain/models"

export function buildWorkSummary(attempt: RunAttempt): string {
  const output = attempt.agentOutput ?? "No output captured"
  const duration = attempt.finishedAt && attempt.startedAt
    ? Math.round((new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime()) / 1000)
    : 0

  return [
    `Symphony: Work completed`,
    ``,
    `**Duration:** ${duration}s`,
    `**Exit code:** ${attempt.exitCode}`,
    ``,
    `### Agent Output`,
    output.length > 4000 ? output.slice(0, 4000) + "\n...(truncated)" : output,
  ].join("\n")
}

export function sortByIssueNumber(issues: Issue[]): void {
  issues.sort((a, b) => {
    const numA = Number.parseInt(a.identifier.split("-")[1] ?? "0", 10)
    const numB = Number.parseInt(b.identifier.split("-")[1] ?? "0", 10)
    return numA - numB
  })
}
