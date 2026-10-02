import { type Issue, type IssueRelation, parseScoreFromLabels } from "../domain/models"
import type { LinearIssueNode } from "./types"

export const LINEAR_ISSUE_FIELDS = `
  id identifier title description url
  state { id name type }
  team { id key }
  labels { nodes { name } }
  parent { id identifier }
  children { nodes { id identifier state { id name type } } }
  relations { nodes { type relatedIssue { id identifier state { id name type } } } }
  inverseRelations { nodes { type issue { id identifier state { id name type } } } }
`

function mapRelationType(type: string): IssueRelation["type"] {
  const map: Record<string, IssueRelation["type"]> = {
    blocks: "blocks",
    "blocked-by": "blocked_by",
    blocked_by: "blocked_by",
    related: "related",
    duplicate: "duplicate",
  }
  return map[type] ?? "related"
}

export function nodeToIssue(node: LinearIssueNode): Issue {
  const labels = node.labels?.nodes?.map((label) => label.name) ?? []
  const outgoing: IssueRelation[] =
    node.relations?.nodes?.map((relation) => ({
      type: mapRelationType(relation.type),
      relatedIssueId: relation.relatedIssue.id,
      relatedIdentifier: relation.relatedIssue.identifier,
      relatedStatus: relation.relatedIssue.state,
    })) ?? []
  const incoming: IssueRelation[] =
    node.inverseRelations?.nodes?.map((relation) => ({
      type: relation.type === "blocks" ? "blocked_by" : mapRelationType(relation.type),
      relatedIssueId: relation.issue.id,
      relatedIdentifier: relation.issue.identifier,
      relatedStatus: relation.issue.state,
    })) ?? []
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
    children: node.children?.nodes?.map((child) => child.id) ?? [],
    relations: [...outgoing, ...incoming],
  }
}
