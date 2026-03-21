/**
 * Routing Resolver — Matches issue labels to routing rules.
 * Determines which workspace root (git repo), agent type, and delivery mode to use per issue.
 */

import type { Config, ScoreRoutingConfig } from "./env"
import type { Issue } from "../domain/models"

export interface ResolvedRoute {
  workspaceRoot: string
  agentType: "claude" | "codex" | "gemini"
  deliveryMode: "merge" | "pr"
  matchedLabel: string | null
}

/**
 * Resolve routing for an issue based on its labels and the configured routing rules.
 * First matching label wins. Falls back to default config if no label matches.
 */
export function resolveRoute(issue: Issue, config: Config): ResolvedRoute {
  for (const rule of config.routingRules) {
    if (issue.labels.includes(rule.label)) {
      return {
        workspaceRoot: rule.workspaceRoot,
        agentType: rule.agentType ?? config.agentType,
        deliveryMode: rule.deliveryMode ?? config.deliveryMode,
        matchedLabel: rule.label,
      }
    }
  }

  return {
    workspaceRoot: config.workspaceRoot,
    agentType: config.agentType,
    deliveryMode: config.deliveryMode,
    matchedLabel: null,
  }
}

/**
 * Resolve routing with score-based fallback.
 * Priority: model:* label > score:N routing > defaultAgentType
 */
export function resolveRouteWithScore(issue: Issue, config: Config): ResolvedRoute {
  const labelRoute = resolveRoute(issue, config)
  if (labelRoute.matchedLabel !== null) return labelRoute

  if (issue.score !== null && config.scoreRouting) {
    const tier = matchScoreTier(issue.score, config.scoreRouting)
    if (tier) {
      return {
        workspaceRoot: config.workspaceRoot,
        agentType: tier.agent,
        deliveryMode: config.deliveryMode,
        matchedLabel: `score:${issue.score}`,
      }
    }
  }

  return {
    workspaceRoot: config.workspaceRoot,
    agentType: config.agentType,
    deliveryMode: config.deliveryMode,
    matchedLabel: null,
  }
}

function matchScoreTier(
  score: number,
  routing: ScoreRoutingConfig,
): { agent: "claude" | "codex" | "gemini" } | null {
  for (const tier of [routing.easy, routing.medium, routing.hard]) {
    if (score >= tier.min && score <= tier.max) {
      return { agent: tier.agent }
    }
  }
  return null
}
