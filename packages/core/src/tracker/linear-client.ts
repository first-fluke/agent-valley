/**
 * Linear Client — GraphQL API for issue queries and mutations.
 */

import { request as httpsRequest } from "node:https"
import type { Issue, IssueRelation } from "../domain/models"
import { parseScoreFromLabels } from "../domain/models"
import { logger } from "../observability/logger"
import type { LinearGraphQLResponse, LinearIssueNode, LinearMutationData, LinearTeamIssuesData } from "./types"
import { linearTeamIssuesDataSchema } from "./types"

const LINEAR_API_URL = "https://api.linear.app/graphql"

// ── GraphQL Helper ──────────────────────────────────────────────────

interface LinearHttpResponse {
  status: number
  statusText: string
  headers: Map<string, string>
  body: string
}

function postGraphQLWithNodeHttps(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<LinearHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables })
    const req = httpsRequest(
      LINEAR_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: apiKey,
        },
        family: 4,
        timeout: 30_000,
      },
      (res) => {
        let responseBody = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          responseBody += chunk
        })
        res.on("end", () => {
          const headers = new Map<string, string>()
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key.toLowerCase(), value)
            else if (Array.isArray(value)) headers.set(key.toLowerCase(), value.join(", "))
          }

          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers,
            body: responseBody,
          })
        })
      },
    )

    req.on("timeout", () => {
      req.destroy(new Error("Linear API request timed out"))
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

async function linearGraphQL<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const useNodeHttpsTransport = typeof Bun === "undefined" && !process.env.VITEST

  const response = !useNodeHttpsTransport
    ? await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      }).then(async (res) => ({
        status: res.status,
        statusText: res.statusText,
        headers: new Map([["retry-after", res.headers.get("Retry-After") ?? ""]]),
        body: await res.text(),
      }))
    : await postGraphQLWithNodeHttps(apiKey, query, variables)

  if (response.status === 401) {
    throw new Error(
      "Linear API authentication failed.\n" +
        "  Fix: Check LINEAR_API_KEY in .env\n" +
        "  Ensure it starts with lin_api_",
    )
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "60"
    throw new Error(`Linear rate limit hit. Retry after ${retryAfter}s`)
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Linear API error: ${response.status} ${response.statusText}\n  Body: ${response.body}`)
  }

  const result = JSON.parse(response.body) as LinearGraphQLResponse<T>

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
        labels { nodes { name } }
        parent { id identifier }
        children { nodes { id identifier state { id name type } } }
        relations { nodes { type relatedIssue { id identifier state { id name type } } } }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`

export async function fetchIssuesByState(apiKey: string, teamUuid: string, stateIds: string[]): Promise<Issue[]> {
  const allIssues: Issue[] = []
  let cursor: string | null = null

  do {
    const data = await linearGraphQL<LinearTeamIssuesData>(apiKey, ISSUES_BY_STATE_QUERY, {
      teamId: teamUuid,
      stateIds,
      cursor,
    })

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

const ISSUE_LABELS_QUERY = `
query GetIssueLabels($issueId: String!) {
  issue(id: $issueId) {
    labels { nodes { name } }
  }
}
`

export async function fetchIssueLabels(apiKey: string, issueId: string): Promise<string[]> {
  const data = await linearGraphQL<{ issue?: { labels?: { nodes: Array<{ name: string }> } } }>(
    apiKey,
    ISSUE_LABELS_QUERY,
    { issueId },
  )
  return data?.issue?.labels?.nodes?.map((l) => l.name) ?? []
}

// ── Mutations ───────────────────────────────────────────────────────

const UPDATE_ISSUE_STATE_MUTATION = `
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}
`

export async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  const data = await linearGraphQL<LinearMutationData>(apiKey, UPDATE_ISSUE_STATE_MUTATION, { issueId, stateId })

  if (!data?.issueUpdate?.success) {
    throw new Error(
      `Failed to update issue state: issueId=${issueId}, stateId=${stateId}\n` +
        "  Fix: Verify stateId exists on the target team and that LINEAR_API_KEY has edit permission.\n" +
        "  Run `bun av setup` to re-discover workflow_states UUIDs.",
    )
  }
}

const ADD_COMMENT_MUTATION = `
mutation AddIssueComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
`

export async function addIssueComment(apiKey: string, issueId: string, body: string): Promise<void> {
  const data = await linearGraphQL<LinearMutationData>(apiKey, ADD_COMMENT_MUTATION, { issueId, body })

  if (!data?.commentCreate?.success) {
    throw new Error(
      `Failed to add comment to issue: issueId=${issueId}\n` +
        "  Fix: Verify LINEAR_API_KEY has comment:create permission for this team.\n" +
        "  If the issue was archived/deleted, the caller should skip the comment instead of retrying.",
    )
  }
}

// ── Label Management ────────────────────────────────────────────────

const FIND_LABEL_QUERY = `
query FindLabel($teamId: String!, $name: String!) {
  issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
    nodes { id name }
  }
}
`

const CREATE_LABEL_MUTATION = `
mutation CreateLabel($teamId: String!, $name: String!) {
  issueLabelCreate(input: { teamId: $teamId, name: $name }) {
    success
    issueLabel { id }
  }
}
`

const ADD_LABEL_TO_ISSUE_MUTATION = `
mutation AddLabelToIssue($issueId: String!, $labelIds: [String!]!) {
  issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
    success
  }
}
`

/**
 * Add a label to an issue by name. Creates the label on-demand if it doesn't exist.
 * Failures are logged but not thrown — label attachment is non-critical for routing.
 */
export async function addIssueLabel(apiKey: string, teamId: string, issueId: string, labelName: string): Promise<void> {
  try {
    // Find existing label
    const findData = await linearGraphQL<{
      issueLabels?: { nodes: Array<{ id: string; name: string }> }
    }>(apiKey, FIND_LABEL_QUERY, { teamId, name: labelName })

    let labelId = findData?.issueLabels?.nodes?.[0]?.id

    // Create label if not found
    if (!labelId) {
      const createData = await linearGraphQL<{
        issueLabelCreate?: { success: boolean; issueLabel?: { id: string } }
      }>(apiKey, CREATE_LABEL_MUTATION, { teamId, name: labelName })

      labelId = createData?.issueLabelCreate?.issueLabel?.id
      if (!labelId) {
        logger.warn("tracker-client", `Failed to create label "${labelName}" for issue ${issueId}`)
        return
      }
    }

    // Fetch current labels to preserve them
    const currentLabels = await fetchIssueLabelsById(apiKey, issueId)
    const allLabelIds = [...new Set([...currentLabels, labelId])]

    // Attach label to issue
    await linearGraphQL<LinearMutationData>(apiKey, ADD_LABEL_TO_ISSUE_MUTATION, { issueId, labelIds: allLabelIds })

    logger.info("tracker-client", `Added label "${labelName}" to issue ${issueId}`)
  } catch (err) {
    logger.warn("tracker-client", `Failed to add label "${labelName}" to issue ${issueId}: ${(err as Error).message}`)
  }
}

const ISSUE_LABEL_IDS_QUERY = `
query GetIssueLabelIds($issueId: String!) {
  issue(id: $issueId) {
    labels { nodes { id } }
  }
}
`

async function fetchIssueLabelsById(apiKey: string, issueId: string): Promise<string[]> {
  const data = await linearGraphQL<{ issue?: { labels?: { nodes: Array<{ id: string }> } } }>(
    apiKey,
    ISSUE_LABEL_IDS_QUERY,
    { issueId },
  )
  return data?.issue?.labels?.nodes?.map((l) => l.id) ?? []
}

// ── Sub-Issue & Relation Mutations ──────────────────────────────────

const CREATE_SUB_ISSUE_MUTATION = `
mutation CreateSubIssue($teamId: String!, $parentId: String!, $title: String!, $description: String!, $stateId: String!) {
  issueCreate(input: { teamId: $teamId, parentId: $parentId, title: $title, description: $description, stateId: $stateId }) {
    success
    issue { id identifier title url }
  }
}
`

export async function createSubIssue(
  apiKey: string,
  teamId: string,
  parentId: string,
  title: string,
  description: string,
  stateId: string,
): Promise<{ id: string; identifier: string; title: string; url: string }> {
  const data = await linearGraphQL<LinearMutationData>(apiKey, CREATE_SUB_ISSUE_MUTATION, {
    teamId,
    parentId,
    title,
    description,
    stateId,
  })
  if (!data?.issueCreate?.success || !data.issueCreate.issue) {
    throw new Error(
      `Failed to create sub-issue under parent ${parentId}\n` +
        "  Fix: Verify parentId exists and LINEAR_API_KEY has issue:create permission on its team.\n" +
        `  If the parent was moved between teams, re-fetch the parent issue before retrying.`,
    )
  }
  return data.issueCreate.issue
}

const CREATE_RELATION_MUTATION = `
mutation CreateIssueRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
    issueRelation { id type }
  }
}
`

/** Linear API IssueRelationType enum values */
export type LinearRelationType = "blocks" | "related" | "duplicate"

export async function createIssueRelation(
  apiKey: string,
  issueId: string,
  relatedIssueId: string,
  type: LinearRelationType,
): Promise<void> {
  await linearGraphQL<LinearMutationData>(apiKey, CREATE_RELATION_MUTATION, {
    issueId,
    relatedIssueId,
    type,
  })
}

const ISSUE_BY_IDENTIFIER_QUERY = `
query GetIssueByIdentifier($teamId: String!, $number: Float!) {
  team(id: $teamId) {
    issues(filter: { number: { eq: $number } }, first: 1) {
      nodes { id identifier }
    }
  }
}
`

export async function fetchIssueByIdentifier(
  apiKey: string,
  teamUuid: string,
  identifier: string,
): Promise<{ id: string; identifier: string } | null> {
  const num = Number(identifier.split("-").pop())
  if (Number.isNaN(num)) return null
  const data = await linearGraphQL<{ team?: { issues?: { nodes: Array<{ id: string; identifier: string }> } } }>(
    apiKey,
    ISSUE_BY_IDENTIFIER_QUERY,
    { teamId: teamUuid, number: num },
  )
  return data?.team?.issues?.nodes?.[0] ?? null
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapRelationType(type: string): IssueRelation["type"] {
  const map: Record<string, IssueRelation["type"]> = {
    blocks: "blocks",
    "blocked-by": "blocked_by",
    related: "related",
    duplicate: "duplicate",
  }
  return map[type] ?? "related"
}

function nodeToIssue(node: LinearIssueNode): Issue {
  const labels = node.labels?.nodes?.map((l) => l.name) ?? []
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    url: node.url,
    status: node.state,
    team: node.team,
    labels,
    score: parseScoreFromLabels(labels),
    parentId: node.parent?.id ?? null,
    children: node.children?.nodes?.map((c) => c.id) ?? [],
    relations:
      node.relations?.nodes?.map((r) => ({
        type: mapRelationType(r.type),
        relatedIssueId: r.relatedIssue.id,
        relatedIdentifier: r.relatedIssue.identifier,
      })) ?? [],
  }
}
