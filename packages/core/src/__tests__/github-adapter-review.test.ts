/**
 * GithubTrackerAdapter tests — pull request review comments for review
 * follow-up. A module-local fetch fake records requests; no network.
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

describe("GithubTrackerAdapter — fetchPullRequestReviewComments", () => {
  test("reads the review's inline comments with their file positions", async () => {
    const { adapter, urls } = makeAdapter(200, [
      { path: "src/flags.ts", line: 12, body: "Rename this flag." },
      { path: "src/old.ts", line: null, original_line: 4, body: "Drop this branch." },
      { path: "README.md", line: null, body: "Mention the flag." },
    ])

    await expect(adapter.fetchPullRequestReviewComments(7, "7001")).resolves.toEqual([
      { path: "src/flags.ts", line: 12, body: "Rename this flag." },
      { path: "src/old.ts", line: 4, body: "Drop this branch." },
      { path: "README.md", line: null, body: "Mention the flag." },
    ])
    expect(urls).toEqual([
      "https://api.github.com/repos/first-fluke/agent-valley/pulls/7/reviews/7001/comments?per_page=100",
    ])
  })

  test("surfaces API failures to the caller", async () => {
    const { adapter } = makeAdapter(404, { message: "Not Found" })
    await expect(adapter.fetchPullRequestReviewComments(7, "7001")).rejects.toThrow(/not found/i)
  })
})
