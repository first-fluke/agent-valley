/**
 * Tests for score-based model routing.
 * Covers: parseScoreFromLabels, parseScoringOutput (via parseExpandedIssue),
 * resolveRouteWithScore, and matchScoreTier.
 */

import { describe, expect, test } from "vitest"
import type { Config } from "../config/env"
import { resolveRouteWithScore } from "../config/routing"
import type { Issue } from "../domain/models"
import { parseScoreFromLabels } from "../domain/models"

// ── parseScoreFromLabels ──────────────────────────────────────────────

describe("parseScoreFromLabels", () => {
  test("parses valid score label", () => {
    expect(parseScoreFromLabels(["backend", "score:7", "urgent"])).toBe(7)
  })

  test("returns null when no score label", () => {
    expect(parseScoreFromLabels(["backend", "urgent"])).toBeNull()
  })

  test("returns null for score:0 (out of range)", () => {
    expect(parseScoreFromLabels(["score:0"])).toBeNull()
  })

  test("returns null for score:11 (out of range)", () => {
    expect(parseScoreFromLabels(["score:11"])).toBeNull()
  })

  test("returns first valid score when multiple exist", () => {
    expect(parseScoreFromLabels(["score:3", "score:8"])).toBe(3)
  })

  test("ignores invalid format", () => {
    expect(parseScoreFromLabels(["score:", "score:abc", "score:-1"])).toBeNull()
  })

  test("handles score:1 and score:10 (boundary)", () => {
    expect(parseScoreFromLabels(["score:1"])).toBe(1)
    expect(parseScoreFromLabels(["score:10"])).toBe(10)
  })
})

// ── resolveRouteWithScore ─────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "",
    status: { id: "s1", name: "Todo", type: "started" },
    team: { id: "t1", key: "TEST" },
    labels: [],
    url: "https://linear.app/test/1",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    linearApiKey: "lin_api_test",
    linearTeamId: "TEST",
    linearTeamUuid: "uuid-test",
    linearWebhookSecret: "whsec_test",
    workflowStates: { todo: "s1", inProgress: "s2", done: "s3", cancelled: "s4" },
    workspaceRoot: "/tmp/ws",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 5,
    serverPort: 9741,
    logLevel: "info",
    logFormat: "json",
    deliveryMode: "merge",
    routingRules: [],
    ...overrides,
  } as Config
}

describe("resolveRouteWithScore", () => {
  test("label routing takes priority over score", () => {
    const issue = makeIssue({ labels: ["backend"], score: 9 })
    const config = makeConfig({
      routingRules: [{ label: "backend", workspaceRoot: "/repos/backend" }],
      scoreRouting: {
        easy: { min: 1, max: 3, agent: "gemini" },
        medium: { min: 4, max: 7, agent: "codex" },
        hard: { min: 8, max: 10, agent: "claude" },
      },
    })

    const route = resolveRouteWithScore(issue, config)
    expect(route.matchedLabel).toBe("backend")
    expect(route.workspaceRoot).toBe("/repos/backend")
  })

  test("score routing when no label match", () => {
    const issue = makeIssue({ score: 2 })
    const config = makeConfig({
      scoreRouting: {
        easy: { min: 1, max: 3, agent: "gemini" },
        medium: { min: 4, max: 7, agent: "codex" },
        hard: { min: 8, max: 10, agent: "claude" },
      },
    })

    const route = resolveRouteWithScore(issue, config)
    expect(route.agentType).toBe("gemini")
    expect(route.matchedLabel).toBe("score:2")
  })

  test("medium tier routing", () => {
    const issue = makeIssue({ score: 5 })
    const config = makeConfig({
      scoreRouting: {
        easy: { min: 1, max: 3, agent: "gemini" },
        medium: { min: 4, max: 7, agent: "codex" },
        hard: { min: 8, max: 10, agent: "claude" },
      },
    })

    const route = resolveRouteWithScore(issue, config)
    expect(route.agentType).toBe("codex")
  })

  test("hard tier routing", () => {
    const issue = makeIssue({ score: 9 })
    const config = makeConfig({
      scoreRouting: {
        easy: { min: 1, max: 3, agent: "gemini" },
        medium: { min: 4, max: 7, agent: "codex" },
        hard: { min: 8, max: 10, agent: "claude" },
      },
    })

    const route = resolveRouteWithScore(issue, config)
    expect(route.agentType).toBe("claude")
  })

  test("falls through to defaultAgentType when score is null", () => {
    const issue = makeIssue({ score: null })
    const config = makeConfig({
      agentType: "codex",
      scoreRouting: {
        easy: { min: 1, max: 3, agent: "gemini" },
        medium: { min: 4, max: 7, agent: "codex" },
        hard: { min: 8, max: 10, agent: "claude" },
      },
    })

    const route = resolveRouteWithScore(issue, config)
    expect(route.agentType).toBe("codex")
    expect(route.matchedLabel).toBeNull()
  })

  test("falls through when scoreRouting not configured", () => {
    const issue = makeIssue({ score: 5 })
    const config = makeConfig({ agentType: "claude" })

    const route = resolveRouteWithScore(issue, config)
    expect(route.agentType).toBe("claude")
    expect(route.matchedLabel).toBeNull()
  })
})
