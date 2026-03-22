/**
 * Orchestrator Helpers tests — buildWorkSummary with auto-commit and diff stat options.
 */
import { describe, expect, test } from "vitest"
import type { RunAttempt } from "../domain/models"
import { buildWorkSummary } from "../orchestrator/helpers"

function makeAttempt(overrides: Partial<RunAttempt> = {}): RunAttempt {
  return {
    id: "attempt-1",
    issueId: "issue-1",
    workspacePath: "/workspace/PROJ-1",
    startedAt: "2026-03-22T00:00:00.000Z",
    finishedAt: "2026-03-22T00:01:00.000Z",
    exitCode: 0,
    agentOutput: "Implemented the feature",
    ...overrides,
  }
}

describe("buildWorkSummary", () => {
  test("basic summary without options", () => {
    const result = buildWorkSummary(makeAttempt())

    expect(result).toContain("Symphony: Work completed")
    expect(result).toContain("**Duration:** 60s")
    expect(result).toContain("**Exit code:** 0")
    expect(result).toContain("Implemented the feature")
    expect(result).not.toContain("Auto-committed")
    expect(result).not.toContain("**Changes:**")
  })

  test("includes auto-commit notice when autoCommitted is true", () => {
    const result = buildWorkSummary(makeAttempt(), { autoCommitted: true })

    expect(result).toContain("**Auto-committed:** Yes")
  })

  test("omits auto-commit notice when autoCommitted is false", () => {
    const result = buildWorkSummary(makeAttempt(), { autoCommitted: false })

    expect(result).not.toContain("Auto-committed")
  })

  test("includes diff stat when provided", () => {
    const result = buildWorkSummary(makeAttempt(), {
      diffStat: "3 files changed, 45 insertions(+), 12 deletions(-)",
    })

    expect(result).toContain("**Changes:** 3 files changed, 45 insertions(+), 12 deletions(-)")
  })

  test("omits diff stat when null", () => {
    const result = buildWorkSummary(makeAttempt(), { diffStat: null })

    expect(result).not.toContain("**Changes:**")
  })

  test("includes both auto-commit and diff stat together", () => {
    const result = buildWorkSummary(makeAttempt(), {
      autoCommitted: true,
      diffStat: "1 file changed, 10 insertions(+)",
    })

    expect(result).toContain("**Auto-committed:** Yes")
    expect(result).toContain("**Changes:** 1 file changed")
    // Auto-commit should appear before Changes
    const autoIdx = result.indexOf("Auto-committed")
    const changesIdx = result.indexOf("**Changes:**")
    expect(autoIdx).toBeLessThan(changesIdx)
  })

  test("truncates long output at 4000 chars", () => {
    const longOutput = "x".repeat(5000)
    const result = buildWorkSummary(makeAttempt({ agentOutput: longOutput }))

    expect(result).toContain("...(truncated)")
    expect(result).not.toContain("x".repeat(5000))
  })

  test("handles null agentOutput", () => {
    const result = buildWorkSummary(makeAttempt({ agentOutput: null }))

    expect(result).toContain("No output captured")
  })

  test("handles zero duration when finishedAt is null", () => {
    const result = buildWorkSummary(makeAttempt({ finishedAt: null }))

    expect(result).toContain("**Duration:** 0s")
  })
})
