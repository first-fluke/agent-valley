/**
 * Linear Client — GraphQL API for issue queries and mutations.
 */

import type { Issue } from "../domain/models"
import type { LinearGraphQLResponse, LinearTeamIssuesData, LinearMutationData, LinearIssueNode } from "./types"
import { linearTeamIssuesDataSchema } from "./types"
import { logger } from "../observability/logger"

const LINEAR_API_URL = "https://api.linear.app/graphql"

// ── GraphQL Helper ──────────────────────────────────────────────────

async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (response.status === 401) {
    throw new Error(
      "Linear API authentication failed.\n" +
      "  Fix: Check LINEAR_API_KEY in .env\n" +
      "  Ensure it starts with lin_api_"
    )
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? "60"
    throw new Error(`Linear rate limit hit. Retry after ${retryAfter}s`)
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Linear API error: ${response.status} ${response.statusText}\n  Body: ${body}`)
  }

  const result = (await response.json()) as LinearGraphQLResponse<T>

  if (result.errors?.length) {
    const msg = result.errors.map((e) => e.message).join("; ")
    throw new Error(`Linear GraphQL error: ${msg}`)
  }

  return result.data as T
}

// ── Queries ─────────────────────────────────────────────────────────

const ISSUES_BY_STATE_QUERY = `
query GetIssuesByState($teamId: String!, $stateIds: [ID!]!, $cursor: String) {
  team(id: $teamId) {
    issues(
      filter: {
        state: { id: { in: $stateIds } }
      }
      first: 50
      after: $cursor
    ) {
      nodes {
        id identifier title description url
        state { id name type }
        team { id key }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`

export async function fetchIssuesByState(
  apiKey: string,
  teamUuid: string,
  stateIds: string[],
): Promise<Issue[]> {
  const allIssues: Issue[] = []
  let cursor: string | null = null

  do {
    const data = await linearGraphQL<LinearTeamIssuesData>(
      apiKey,
      ISSUES_BY_STATE_QUERY,
      { teamId: teamUuid, stateIds, cursor },
    )

    const parsed = linearTeamIssuesDataSchema.safeParse(data)
    if (!parsed.success) {
      throw new Error(`Linear API response validation failed: ${parsed.error.message}`)
    }

    const issues = parsed.data?.team?.issues
    const nodes = issues?.nodes ?? []
    allIssues.push(...nodes.map(nodeToIssue))

    cursor = issues?.pageInfo?.hasNextPage ? (issues.pageInfo.endCursor ?? null) : null
  } while (cursor)

  logger.info("tracker-client", `Fetched ${allIssues.length} issues for states`, { stateIds: stateIds.join(",") })

  return allIssues
}

// ── Mutations ───────────────────────────────────────────────────────

const UPDATE_ISSUE_STATE_MUTATION = `
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}
`

export async function updateIssueState(
  apiKey: string,
  issueId: string,
  stateId: string,
): Promise<void> {
  const data = await linearGraphQL<LinearMutationData>(
    apiKey,
    UPDATE_ISSUE_STATE_MUTATION,
    { issueId, stateId },
  )

  if (!data?.issueUpdate?.success) {
    throw new Error(`Failed to update issue state: issueId=${issueId}, stateId=${stateId}`)
  }
}

const ADD_COMMENT_MUTATION = `
mutation AddIssueComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
`

export async function addIssueComment(
  apiKey: string,
  issueId: string,
  body: string,
): Promise<void> {
  const data = await linearGraphQL<LinearMutationData>(
    apiKey,
    ADD_COMMENT_MUTATION,
    { issueId, body },
  )

  if (!data?.commentCreate?.success) {
    throw new Error(`Failed to add comment to issue: issueId=${issueId}`)
  }
}

// ── Issue Lookup ──────────────────────────────────────────────────

const ISSUE_BY_NUMBER_QUERY = `
query GetIssueByNumber($teamId: String!, $number: Float!) {
  team(id: $teamId) {
    issues(filter: { number: { eq: $number } }, first: 1) {
      nodes {
        id identifier title description url
        state { id name type }
        team { id key }
      }
    }
  }
}
`

export async function fetchIssueByIdentifier(
  apiKey: string,
  teamUuid: string,
  identifier: string,
): Promise<Issue | null> {
  const match = identifier.match(/-(\d+)$/)
  if (!match) {
    logger.warn("tracker-client", `Cannot parse issue number from identifier "${identifier}". Expected format: KEY-123`)
    return null
  }
  const issueNumber = parseInt(match[1]!, 10)

  const data = await linearGraphQL<LinearTeamIssuesData>(
    apiKey,
    ISSUE_BY_NUMBER_QUERY,
    { teamId: teamUuid, number: issueNumber },
  )

  const parsed = linearTeamIssuesDataSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error(`Linear API response validation failed: ${parsed.error.message}`)
  }

  const nodes = parsed.data?.team?.issues?.nodes ?? []
  if (nodes.length === 0) return null

  return nodeToIssue(nodes[0]!)
}

// ── Helpers ─────────────────────────────────────────────────────────

function nodeToIssue(node: LinearIssueNode): Issue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    url: node.url,
    status: node.state,
    team: node.team,
  }
}
