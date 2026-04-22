/**
 * LinearTrackerAdapter — Infrastructure adapter implementing the domain
 * `IssueTracker` port against Linear's GraphQL API.
 *
 * Composition only: delegates to the existing module functions in
 * `../linear-client.ts` so their 15+ unit tests continue to mock that
 * module path unchanged.
 *
 * Design: docs/plans/domain-ports-di-seam-design.md § 3.2
 */

import type { Issue } from "../../domain/models"
import type { IssueTracker } from "../../domain/ports/tracker"
import {
  addIssueComment as addIssueCommentFn,
  addIssueLabel as addIssueLabelFn,
  fetchIssueLabels as fetchIssueLabelsFn,
  fetchIssuesByState as fetchIssuesByStateFn,
  updateIssueState as updateIssueStateFn,
} from "../linear-client"

export interface LinearTrackerAdapterConfig {
  apiKey: string
  /** Linear team key (e.g. "PROJ") — used for label attach mutations. */
  teamId: string
  /** Linear team UUID — used for team-scoped issue queries. */
  teamUuid: string
}

export class LinearTrackerAdapter implements IssueTracker {
  constructor(private readonly config: LinearTrackerAdapterConfig) {
    if (!config.apiKey) {
      throw new Error(
        "LinearTrackerAdapter: apiKey is required.\n" +
          "  Fix: pass config.linearApiKey when constructing the adapter.\n" +
          "  Source: ~/.config/agent-valley/settings.yaml or LINEAR_API_KEY env var.",
      )
    }
    if (!config.teamId) {
      throw new Error(
        "LinearTrackerAdapter: teamId is required.\n" +
          "  Fix: pass config.linearTeamId when constructing the adapter.\n" +
          "  Source: valley.yaml `linear.teamId`.",
      )
    }
    if (!config.teamUuid) {
      throw new Error(
        "LinearTrackerAdapter: teamUuid is required.\n" +
          "  Fix: pass config.linearTeamUuid when constructing the adapter.\n" +
          "  Source: valley.yaml `linear.teamUuid` (run `bun av setup` to discover it).",
      )
    }
  }

  fetchIssuesByState(stateIds: string[]): Promise<Issue[]> {
    return fetchIssuesByStateFn(this.config.apiKey, this.config.teamUuid, stateIds)
  }

  fetchIssueLabels(issueId: string): Promise<string[]> {
    return fetchIssueLabelsFn(this.config.apiKey, issueId)
  }

  updateIssueState(issueId: string, stateId: string): Promise<void> {
    return updateIssueStateFn(this.config.apiKey, issueId, stateId)
  }

  addIssueComment(issueId: string, body: string): Promise<void> {
    return addIssueCommentFn(this.config.apiKey, issueId, body)
  }

  addIssueLabel(issueId: string, labelName: string): Promise<void> {
    return addIssueLabelFn(this.config.apiKey, this.config.teamId, issueId, labelName)
  }
}
