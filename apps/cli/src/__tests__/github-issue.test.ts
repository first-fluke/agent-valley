import type { GithubTrackerConfig } from "@agent-valley/core/config/yaml-loader"
import { describe, expect, it, vi } from "vitest"
import { createGithubIssue } from "../github-issue"

const config: GithubTrackerConfig = {
  token: "test-token",
  owner: "acme",
  repo: "project",
  webhookSecret: "test-secret",
  labels: { todo: "valley:todo", inProgress: "valley:wip", done: "valley:done", cancelled: "valley:cancelled" },
}

describe("GitHub issue creation", () => {
  it("creates an issue with the dispatch and routing labels in the initial request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          number: 12,
          title: "Fix login",
          html_url: "https://github.com/acme/project/issues/12",
        },
        { status: 201 },
      ),
    )
    const issue = await createGithubIssue(
      config,
      {
        title: "Fix login",
        description: "Handle expired tokens",
        scope: "api",
        score: 3,
      },
      fetcher,
    )
    expect(issue.identifier).toBe("acme/project#12")
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/project/issues")
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      title: "Fix login",
      body: "Handle expired tokens",
      labels: ["valley:todo", "scope:api", "score:3"],
    })
  })

  it("keeps an existing scope prefix and omits score when no expansion occurred", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ number: 1, title: "Task", html_url: "url" }))
    await createGithubIssue(config, { title: "Task", description: "", scope: "scope:api" }, fetcher)
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).labels).toEqual(["valley:todo", "scope:api"])
  })

  it("reports permission failures without leaking credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }))
    await expect(createGithubIssue(config, { title: "Task", description: "" }, fetcher)).rejects.toThrow(
      "Issues write permission",
    )
  })

  it("rejects malformed success responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ number: "invalid" }))
    await expect(createGithubIssue(config, { title: "Task", description: "" }, fetcher)).rejects.toThrow(
      "before retrying",
    )
  })
})
