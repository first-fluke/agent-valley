/**
 * GithubTrackerAdapter tests — finding an issue by the identifier an Agent
 * Valley branch carries. A module-local fetch fake records requests.
 */

import { describe, expect, test } from "vitest"
import { GithubTrackerAdapter } from "../tracker/adapters/github-adapter"

function makeAdapter(status: number, body: unknown) {
  const urls: string[] = []
  const fetchFake = (async (input: string | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  const adapter = new GithubTrackerAdapter({
    token: "ghp_test",
    owner: "first-fluke",
    repo: "agent-valley",
    labels: { todo: "valley:todo", inProgress: "valley:wip", done: "valley:done", cancelled: "valley:cancelled" },
    fetch: fetchFake,
  })
  return { adapter, urls }
}

const ISSUE = {
  number: 42,
  title: "feat: rename the flag",
  body: "Details",
  state: "closed",
  html_url: "https://github.com/first-fluke/agent-valley/issues/42",
  labels: [{ name: "valley:done" }],
}

describe("GithubTrackerAdapter — findIssueByIdentifier", () => {
  test("fetches the issue of this repository, in any casing", async () => {
    const { adapter, urls } = makeAdapter(200, ISSUE)

    const issue = await adapter.findIssueByIdentifier("First-Fluke/Agent-Valley#42")

    expect(issue).toMatchObject({ id: "42", identifier: "first-fluke/agent-valley#42", status: { id: "valley:done" } })
    expect(urls).toEqual(["https://api.github.com/repos/first-fluke/agent-valley/issues/42"])
  })

  test("returns null without a request for other repositories and other identifier shapes", async () => {
    const { adapter, urls } = makeAdapter(200, ISSUE)
    for (const identifier of ["other/repo#42", "ACR-42", "first-fluke/agent-valley#0", "login"]) {
      expect(await adapter.findIssueByIdentifier(identifier)).toBeNull()
    }
    expect(urls).toEqual([])
  })

  test("returns null for pull requests and missing issues", async () => {
    const pr = makeAdapter(200, { ...ISSUE, pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" } })
    expect(await pr.adapter.findIssueByIdentifier("first-fluke/agent-valley#42")).toBeNull()

    const missing = makeAdapter(404, { message: "Not Found" })
    expect(await missing.adapter.findIssueByIdentifier("first-fluke/agent-valley#42")).toBeNull()
  })

  test("surfaces other API failures", async () => {
    const { adapter } = makeAdapter(500, { message: "boom" })
    await expect(adapter.findIssueByIdentifier("first-fluke/agent-valley#42")).rejects.toThrow(/GitHub API error/)
  })
})
