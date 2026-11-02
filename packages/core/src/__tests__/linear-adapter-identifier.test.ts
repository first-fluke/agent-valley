/**
 * LinearTrackerAdapter tests — finding an issue by the identifier an Agent
 * Valley branch carries. Linear HTTP is mocked at the module level.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import { makeIssue } from "./characterization/helpers"

vi.mock("../tracker/linear-client", () => ({
  fetchIssue: vi.fn(),
}))

import { LinearTrackerAdapter } from "../tracker/adapters/linear-adapter"
import * as linearClient from "../tracker/linear-client"

const fetchIssue = vi.mocked(linearClient.fetchIssue)

function makeAdapter() {
  return new LinearTrackerAdapter({ apiKey: "lin_api_test", teamId: "ACR", teamUuid: "team-uuid" })
}

describe("LinearTrackerAdapter — findIssueByIdentifier", () => {
  beforeEach(() => {
    fetchIssue.mockReset()
  })

  test("looks the identifier up through issue(id:)", async () => {
    const issue = makeIssue({ id: "uuid-42", identifier: "ACR-42" })
    fetchIssue.mockResolvedValue(issue)

    await expect(makeAdapter().findIssueByIdentifier("ACR-42")).resolves.toBe(issue)
    expect(fetchIssue).toHaveBeenCalledWith("lin_api_test", "ACR-42")
  })

  test("returns null without a request for other teams and other identifier shapes", async () => {
    for (const identifier of ["ENG-42", "first-fluke/agent-valley#42", "login", "ACR-0"]) {
      expect(await makeAdapter().findIssueByIdentifier(identifier)).toBeNull()
    }
    expect(fetchIssue).not.toHaveBeenCalled()
  })

  test("returns null when Linear has no such issue or resolves a different one", async () => {
    fetchIssue.mockResolvedValueOnce(null)
    expect(await makeAdapter().findIssueByIdentifier("ACR-42")).toBeNull()

    fetchIssue.mockResolvedValueOnce(makeIssue({ identifier: "ACR-7" }))
    expect(await makeAdapter().findIssueByIdentifier("ACR-42")).toBeNull()
  })
})
