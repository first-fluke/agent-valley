import type { Config } from "@agent-valley/core/config/yaml-loader"
import {
  createIssueRelation,
  ensureIssueLabelId,
  fetchIssueByIdentifier,
  linearGraphQL,
  updateIssueState,
} from "@agent-valley/core/tracker/linear-client"

export interface CreatedLinearIssue {
  id: string
  identifier: string
  title: string
  url: string
}

export async function findDraftState(config: Config): Promise<string> {
  const data = await linearGraphQL<{ team?: { states?: { nodes: Array<{ id: string; type: string }> } } }>(
    config.linearApiKey,
    "query DraftStates($teamId: String!) { team(id: $teamId) { states { nodes { id type } } } }",
    { teamId: config.linearTeamUuid },
  )
  const state = data?.team?.states?.nodes.find(
    (node) => node.type === "backlog" && node.id !== config.workflowStates.todo,
  )
  if (!state)
    throw new Error(
      "A Linear Backlog state is required to prepare dependencies safely. Add a Backlog state to the configured team before retrying.",
    )
  return state.id
}

export async function createLinearIssueInState(
  config: Config,
  input: { title: string; description: string; stateId: string; parentId?: string | null; labelIds?: string[] },
): Promise<CreatedLinearIssue> {
  const data = await linearGraphQL<{ issueCreate?: { success: boolean; issue?: CreatedLinearIssue } }>(
    config.linearApiKey,
    `mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $stateId: String!, $parentId: String, $labelIds: [String!]) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description, stateId: $stateId, parentId: $parentId, labelIds: $labelIds }) {
        success issue { id identifier title url }
      }
    }`,
    { teamId: config.linearTeamUuid, ...input },
  )
  if (!data?.issueCreate?.success || !data.issueCreate.issue) throw new Error("Linear issue creation failed")
  return data.issueCreate.issue
}

/** Publish only after required routing and dependency metadata is in place. */
export async function createLinearIssue(
  config: Config,
  input: {
    title: string
    description: string
    parentId?: string | null
    scope?: string
    score?: number | null
    blockedBy?: string
  },
): Promise<CreatedLinearIssue> {
  const labelNames: string[] = []
  if (input.scope) labelNames.push(input.scope.startsWith("scope:") ? input.scope : `scope:${input.scope}`)
  if (input.score != null) labelNames.push(`score:${input.score}`)
  const blocker = input.blockedBy
    ? await fetchIssueByIdentifier(config.linearApiKey, config.linearTeamUuid, input.blockedBy)
    : null
  if (input.blockedBy && (!blocker || blocker.identifier !== input.blockedBy)) {
    throw new Error(
      `Blocking issue ${input.blockedBy} was not found in the configured Linear team. No issue was created.`,
    )
  }
  const stateId = blocker ? await findDraftState(config) : config.workflowStates.todo
  const labelIds: string[] = []
  for (const name of labelNames)
    labelIds.push(await ensureIssueLabelId(config.linearApiKey, config.linearTeamUuid, name))
  const issue = await createLinearIssueInState(config, {
    title: input.title,
    description: input.description,
    parentId: input.parentId,
    stateId,
    labelIds,
  })
  if (blocker) {
    try {
      await createIssueRelation(config.linearApiKey, blocker.id, issue.id, "blocks")
      await updateIssueState(config.linearApiKey, issue.id, config.workflowStates.todo)
    } catch (error) {
      throw new Error(
        `Issue ${issue.identifier} was created in Backlog, but publishing failed: ${(error as Error).message}. Inspect ${issue.url}, confirm its blocking relation, then move it to Todo. Do not create a duplicate.`,
      )
    }
  }
  return issue
}
