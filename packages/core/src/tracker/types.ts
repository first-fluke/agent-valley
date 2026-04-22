/**
 * Tracker types — Linear webhook and API response types.
 *
 * PR4: the `LinearParsedWebhookEvent` union (formerly exported as
 * `ParsedWebhookEvent`) is now adapter-internal. Orchestrator consumes
 * the domain-level `ParsedWebhookEvent` from `domain/parsed-webhook-event.ts`.
 */

import { z } from "zod"
import type { Issue } from "../domain/models"

export interface LinearIssueWebhookEvent {
  kind?: undefined
  action: "create" | "update" | "remove"
  issueId: string
  issue: Issue
  stateId: string
  prevStateId: string | null
}

export interface LinearRelationWebhookEvent {
  kind: "relation"
  action: "create" | "remove"
  issueId: string
  relatedIssueId: string
  relationType: string
}

export type LinearParsedWebhookEvent = LinearIssueWebhookEvent | LinearRelationWebhookEvent

/**
 * @deprecated Kept for `tracker/webhook-handler.ts` and existing unit tests
 * only. Use `domain/parsed-webhook-event.ts::ParsedWebhookEvent` at the
 * Orchestrator boundary.
 */
export type WebhookEvent = LinearIssueWebhookEvent
/** @deprecated See `WebhookEvent`. */
export type RelationWebhookEvent = LinearRelationWebhookEvent
/** @deprecated See `WebhookEvent`. */
export type ParsedWebhookEvent = LinearParsedWebhookEvent

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
  issueCreate?: { success: boolean; issue?: { id: string; identifier: string; title: string; url: string } }
  issueRelationCreate?: { issueRelation?: { id: string; type: string } }
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
  parent?: { id: string; identifier: string } | null
  children?: { nodes: Array<{ id: string; identifier: string; state: { id: string; name: string; type: string } }> }
  relations?: {
    nodes: Array<{
      type: string
      relatedIssue: { id: string; identifier: string; state: { id: string; name: string; type: string } }
    }>
  }
}

// ── Zod Schemas for Runtime Validation ──────────────────────────────

const linearRelatedIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
})

export const linearIssueNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
  url: z.string(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  team: z.object({ id: z.string(), key: z.string() }),
  labels: z
    .object({
      nodes: z.array(z.object({ name: z.string() })),
    })
    .optional()
    .default({ nodes: [] }),
  parent: z.object({ id: z.string(), identifier: z.string() }).nullable().optional().default(null),
  children: z
    .object({
      nodes: z.array(linearRelatedIssueSchema),
    })
    .optional()
    .default({ nodes: [] }),
  relations: z
    .object({
      nodes: z.array(
        z.object({
          type: z.string(),
          relatedIssue: linearRelatedIssueSchema,
        }),
      ),
    })
    .optional()
    .default({ nodes: [] }),
})

export const linearTeamIssuesDataSchema = z.object({
  team: z
    .object({
      issues: z.object({
        nodes: z.array(linearIssueNodeSchema),
        pageInfo: z
          .object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          })
          .optional(),
      }),
    })
    .nullable(),
})

export const linearMutationDataSchema = z.object({
  issueUpdate: z.object({ success: z.boolean() }).optional(),
  commentCreate: z.object({ success: z.boolean() }).optional(),
})
