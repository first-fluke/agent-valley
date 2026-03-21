/**
 * Integrations — Barrel export and factory for external tool integrations.
 */

export * from "./types"
export { IntegrationDispatcher } from "./integration-dispatcher"
export { GitHubIntegration } from "./github-integration"
export { SlackIntegration } from "./slack-integration"

import { logger } from "../observability/logger"
import { GitHubIntegration } from "./github-integration"
import { SlackIntegration } from "./slack-integration"
import { IntegrationDispatcher } from "./integration-dispatcher"
import type { Integration } from "./types"

const COMPONENT = "IntegrationFactory"

interface IntegrationsConfig {
  github?: { token: string; owner: string; repo: string }
  slack?: { webhookUrl: string }
}

export function createIntegrationDispatcher(config: IntegrationsConfig): IntegrationDispatcher {
  const integrations: Integration[] = []
  const active: string[] = []

  if (config.github) {
    integrations.push(new GitHubIntegration(config.github))
    active.push("github")
  }

  if (config.slack) {
    integrations.push(new SlackIntegration(config.slack))
    active.push("slack")
  }

  logger.info(COMPONENT, "Integrations configured", {
    count: integrations.length,
    active: active.join(", ") || "none",
  })

  return new IntegrationDispatcher(integrations)
}
