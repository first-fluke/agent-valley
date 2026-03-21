/**
 * Tracker types — Linear webhook and API response types.
 */

import { z } from "zod/v4"
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
      pageInfo?: {
        hasNextPage: boolean
        endCursor: string | null
      }
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
  labels: { nodes: Array<{ name: string }> }
}

// ── Zod Schemas for Runtime Validation ──────────────────────────────

export const linearIssueNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().transform(v => v ?? ""),
  url: z.string(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  team: z.object({ id: z.string(), key: z.string() }),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string() })),
  }).optional().default({ nodes: [] }),
})

export const linearTeamIssuesDataSchema = z.object({
  team: z.object({
    issues: z.object({
      nodes: z.array(linearIssueNodeSchema),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }).optional(),
    }),
  }).nullable(),
})

export const linearMutationDataSchema = z.object({
  issueUpdate: z.object({ success: z.boolean() }).optional(),
  commentCreate: z.object({ success: z.boolean() }).optional(),
})
