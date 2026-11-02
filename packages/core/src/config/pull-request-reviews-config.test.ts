import { describe, expect, it } from "vitest"
import { globalConfigSchema, projectConfigSchema, resolveConfig } from "./yaml-loader"

function resolve(project: Record<string, unknown>) {
  const global = globalConfigSchema.parse({ linear: { api_key: "lin_api_test" } })
  return resolveConfig(
    global,
    projectConfigSchema.parse({ workspace: { root: "/workspace/repo" }, prompt: "Do the issue", ...project }),
    { GITHUB_TOKEN: "test-only-token" },
  )
}

const LINEAR = {
  team_id: "ACR",
  team_uuid: "team-uuid",
  webhook_secret: "whsec_linear",
  workflow_states: { todo: "s-todo", in_progress: "s-ip", done: "s-done", cancelled: "s-cancelled" },
}

const GITHUB = {
  owner: "first-fluke",
  repo: "agent-valley",
  token_env: "GITHUB_TOKEN",
  webhook_secret: "whsec_github",
  labels: { todo: "todo", in_progress: "doing", done: "done", cancelled: "cancelled" },
}

describe("pull request review follow-up configuration", () => {
  it("is off by default", () => {
    expect(resolve({ linear: LINEAR }).pullRequestReviews).toEqual({
      enabled: false,
      webhookSecret: "",
      ignoreAuthors: [],
    })
  })

  it("uses its own GitHub webhook secret with the Linear tracker", () => {
    const config = resolve({
      linear: LINEAR,
      delivery: {
        mode: "pr",
        pull_request_reviews: { enabled: true, webhook_secret: "whsec_reviews", ignore_authors: ["release-bot"] },
      },
    })
    expect(config.pullRequestReviews).toEqual({
      enabled: true,
      webhookSecret: "whsec_reviews",
      ignoreAuthors: ["release-bot"],
    })
  })

  it("reuses github.webhook_secret with the GitHub tracker", () => {
    const config = resolve({
      tracker: { kind: "github" },
      github: GITHUB,
      delivery: { mode: "pr", pull_request_reviews: { enabled: true, webhook_secret: "ignored" } },
    })
    expect(config.pullRequestReviews?.webhookSecret).toBe("whsec_github")
  })

  it("still honors the 4.6.0 switch github.comment_relay.pull_request_reviews for the GitHub tracker", () => {
    const github = resolve({
      tracker: { kind: "github" },
      github: { ...GITHUB, comment_relay: { enabled: true, pull_request_reviews: true } },
    })
    expect(github.pullRequestReviews).toEqual({ enabled: true, webhookSecret: "whsec_github", ignoreAuthors: [] })

    const explicit = resolve({
      tracker: { kind: "github" },
      github: { ...GITHUB, comment_relay: { pull_request_reviews: true } },
      delivery: { pull_request_reviews: { enabled: false } },
    })
    expect(explicit.pullRequestReviews?.enabled).toBe(false)
  })

  it("refuses to enable follow-up without a webhook secret", () => {
    expect(() => resolve({ linear: LINEAR, delivery: { pull_request_reviews: { enabled: true } } })).toThrow(
      /delivery\.pull_request_reviews\.webhook_secret/,
    )
  })
})
