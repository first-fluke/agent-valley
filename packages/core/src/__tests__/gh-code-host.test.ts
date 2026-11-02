/**
 * GhCliCodeHost tests — pull request review comments through `gh api`,
 * with the command runner injected so no process is spawned.
 */

import { describe, expect, test, vi } from "vitest"
import { GhCliCodeHost } from "../workspace/adapters/gh-code-host"

function makeHost(result: { exitCode: number; stdout?: string; stderr?: string }) {
  const run = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: "", stderr: "", ...result }))
  return { host: new GhCliCodeHost(run), run }
}

describe("GhCliCodeHost — fetchPullRequestReviewComments", () => {
  test("reads the review's inline comments with their file positions", async () => {
    const { host, run } = makeHost({
      exitCode: 0,
      stdout: JSON.stringify([
        { path: "src/flags.ts", line: 12, body: "Rename this flag." },
        { path: "src/old.ts", line: null, original_line: 4, body: "Drop this branch." },
        { path: "README.md", line: null, body: "Mention the flag." },
      ]),
    })

    await expect(host.fetchPullRequestReviewComments("first-fluke/agent-valley", 7, "7001")).resolves.toEqual([
      { path: "src/flags.ts", line: 12, body: "Rename this flag." },
      { path: "src/old.ts", line: 4, body: "Drop this branch." },
      { path: "README.md", line: null, body: "Mention the flag." },
    ])
    expect(run).toHaveBeenCalledWith("gh", [
      "api",
      "repos/first-fluke/agent-valley/pulls/7/reviews/7001/comments?per_page=100",
    ])
  })

  test("surfaces gh failures with a fix hint", async () => {
    const { host } = makeHost({ exitCode: 1, stderr: "HTTP 401: Bad credentials" })
    await expect(host.fetchPullRequestReviewComments("first-fluke/agent-valley", 7, "7001")).rejects.toThrow(
      /Bad credentials[\s\S]*gh auth status/,
    )
  })

  test("refuses references that could alter the API path", async () => {
    const { host, run } = makeHost({ exitCode: 0, stdout: "[]" })
    for (const [repository, reviewId] of [
      ["first-fluke/agent-valley/../x", "7001"],
      ["first-fluke/agent-valley", "7001/../../x"],
    ] as const) {
      await expect(host.fetchPullRequestReviewComments(repository, 7, reviewId)).rejects.toThrow(/Invalid/)
    }
    expect(run).not.toHaveBeenCalled()
  })
})
