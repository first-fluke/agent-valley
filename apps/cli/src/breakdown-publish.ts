import type { Config } from "@agent-valley/core/config/yaml-loader"
import { createIssueRelation, ensureIssueLabelId, updateIssueState } from "@agent-valley/core/tracker/linear-client"
import type { BreakdownResult } from "./breakdown"
import { type CreatedLinearIssue, createLinearIssueInState, findDraftState } from "./linear-issue"

export function validateBreakdown(result: BreakdownResult): void {
  if (!result.parentTitle.trim() || result.subIssues.length === 0)
    throw new Error("Breakdown must contain a parent and at least one sub-issue.")
  const visited = new Set<number>()
  const visiting = new Set<number>()
  const visit = (index: number): void => {
    if (visiting.has(index))
      throw new Error("Breakdown contains a dependency cycle. Revise the tasks before creating issues.")
    if (visited.has(index)) return
    const issue = result.subIssues[index]
    if (!issue?.title.trim()) throw new Error(`Sub-issue ${index + 1} has no title.`)
    visiting.add(index)
    for (const dependency of issue.blockedByIndices) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 1 ||
        dependency > result.subIssues.length ||
        dependency === index + 1
      ) {
        throw new Error(
          `Sub-issue ${index + 1} has an invalid dependency: ${dependency}. Use another sub-issue's 1-based index.`,
        )
      }
      visit(dependency - 1)
    }
    visiting.delete(index)
    visited.add(index)
  }
  result.subIssues.forEach((_, index) => {
    visit(index)
  })
}

export async function publishBreakdown(
  config: Config,
  result: BreakdownResult,
  scope?: string,
): Promise<{
  parent: CreatedLinearIssue
  children: Array<CreatedLinearIssue & { index: number }>
  relationsCreated: number
}> {
  validateBreakdown(result)
  const draftState = await findDraftState(config)
  const labelIds = scope
    ? [
        await ensureIssueLabelId(
          config.linearApiKey,
          config.linearTeamUuid,
          scope.startsWith("scope:") ? scope : `scope:${scope}`,
        ),
      ]
    : []
  const children: Array<CreatedLinearIssue & { index: number }> = []
  const parent = await createLinearIssueInState(config, {
    title: result.parentTitle,
    description: result.parentDescription,
    stateId: draftState,
    labelIds,
  })
  let relationsCreated = 0
  let publishing = false
  try {
    for (const [index, issue] of result.subIssues.entries()) {
      const child = await createLinearIssueInState(config, {
        title: issue.title,
        description: issue.description,
        parentId: parent.id,
        stateId: draftState,
        labelIds,
      })
      children.push({ ...child, index: index + 1 })
    }
    for (const child of children) {
      for (const dependency of new Set(result.subIssues[child.index - 1]?.blockedByIndices)) {
        const blocker = children[dependency - 1]
        if (!blocker) throw new Error(`Missing dependency ${dependency}`)
        await createIssueRelation(config.linearApiKey, blocker.id, child.id, "blocks")
        relationsCreated++
      }
    }
    // Publish dependants first, so their blockers cannot finish before they are visible.
    const remaining = new Set(children.map((child) => child.index))
    const publishOrder: typeof children = []
    while (remaining.size) {
      const next = children.find(
        (child) =>
          remaining.has(child.index) &&
          !result.subIssues.some(
            (issue, index) => remaining.has(index + 1) && issue.blockedByIndices.includes(child.index),
          ),
      )
      if (!next) throw new Error("Cannot order breakdown dependencies")
      publishOrder.push(next)
      remaining.delete(next.index)
    }
    publishing = true
    for (const child of publishOrder) await updateIssueState(config.linearApiKey, child.id, config.workflowStates.todo)
    // Parent becomes runnable only after all children and relations exist.
    await updateIssueState(config.linearApiKey, parent.id, config.workflowStates.todo)
  } catch (error) {
    throw new Error(
      `Breakdown preparation failed: ${(error as Error).message}. ${publishing ? "Some tasks may already be in Todo; inspect their states before retrying." : "Created issues remain in Backlog and were not dispatched."} Parent: ${parent.url}. Created children: ${children.map((child) => child.identifier).join(", ") || "none"}. Repair this draft instead of creating duplicates.`,
    )
  }
  return { parent, children, relationsCreated }
}
