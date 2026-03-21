/**
 * Integration types — Contracts for external tool integrations.
 */

import type { IntegrationEvent, IntegrationStatus } from "../domain/models"

export interface Integration {
  readonly type: string
  status(): IntegrationStatus
  notify(event: IntegrationEvent): Promise<void>
}

export interface GitHubPullRequest {
  number: number
  title: string
  url: string
  state: "open" | "closed" | "merged"
  branch: string
}
