/**
 * FakeIssueTracker — in-memory IssueTracker for unit and contract tests.
 * Records all mutation calls for assertion and supports pre-seeded issues.
 */

import type { Issue } from "../../domain/models"
import type { IssueTracker } from "../../domain/ports/tracker"

export interface RecordedCall {
  method: string
  args: unknown[]
}

export class FakeIssueTracker implements IssueTracker {
  public readonly calls: RecordedCall[] = []

  /** issueId -> Issue. Tests seed this to simulate tracker contents. */
  public readonly issues = new Map<string, Issue>()

  /** issueId -> comments posted (in order). */
  public readonly comments = new Map<string, string[]>()

  /** issueId -> set of label names attached. */
  public readonly labelsOnIssue = new Map<string, Set<string>>()

  /** Optional: map method name -> Error to throw on next call. */
  public readonly throwOn = new Map<string, Error>()

  seedIssue(issue: Issue): void {
    this.issues.set(issue.id, issue)
    if (!this.labelsOnIssue.has(issue.id)) {
      this.labelsOnIssue.set(issue.id, new Set(issue.labels))
    }
  }

  private maybeThrow(method: string): void {
    const err = this.throwOn.get(method)
    if (err) {
      this.throwOn.delete(method)
      throw err
    }
  }

  async fetchIssuesByState(stateIds: string[]): Promise<Issue[]> {
    this.calls.push({ method: "fetchIssuesByState", args: [stateIds] })
    this.maybeThrow("fetchIssuesByState")
    const wanted = new Set(stateIds)
    return [...this.issues.values()].filter((i) => wanted.has(i.status.id))
  }

  async fetchIssueLabels(issueId: string): Promise<string[]> {
    this.calls.push({ method: "fetchIssueLabels", args: [issueId] })
    this.maybeThrow("fetchIssueLabels")
    const set = this.labelsOnIssue.get(issueId)
    return set ? [...set] : []
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    this.calls.push({ method: "updateIssueState", args: [issueId, stateId] })
    this.maybeThrow("updateIssueState")
    const issue = this.issues.get(issueId)
    if (issue) {
      issue.status = { ...issue.status, id: stateId }
    }
  }

  async addIssueComment(issueId: string, body: string): Promise<void> {
    this.calls.push({ method: "addIssueComment", args: [issueId, body] })
    this.maybeThrow("addIssueComment")
    const arr = this.comments.get(issueId) ?? []
    arr.push(body)
    this.comments.set(issueId, arr)
  }

  async addIssueLabel(issueId: string, labelName: string): Promise<void> {
    this.calls.push({ method: "addIssueLabel", args: [issueId, labelName] })
    this.maybeThrow("addIssueLabel")
    const set = this.labelsOnIssue.get(issueId) ?? new Set<string>()
    set.add(labelName)
    this.labelsOnIssue.set(issueId, set)
  }
}
