/**
 * Tracker types — Linear webhook and API response types.
 */

import type { Issue } from "../domain/models"

export interface WebhookEvent {
  action: "create" | "update" | "remove"
  issueId: string
  issue: Issue
  stateId: string
  prevStateId: string | null
}

export interface LinearGraphQLResponse<T = LinearTeamIssuesData> {
  data?: T
  errors?: Array<{ message: string }>
}

export interface LinearTeamIssuesData {
  team?: {
    issues?: {
      nodes: LinearIssueNode[]
    }
  }
}

export interface LinearMutationData {
  issueUpdate?: { success: boolean }
  commentCreate?: { success: boolean }
}

export interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  state: { id: string; name: string; type: string }
  team: { id: string; key: string }
}
