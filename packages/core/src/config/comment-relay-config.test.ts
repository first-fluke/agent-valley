import { describe, expect, it } from "vitest"
import { globalConfigSchema, projectConfigSchema, resolveConfig } from "./yaml-loader"

const RELAY = { enabled: true, ignore_authors: ["release-bot"] }

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
  webhook_secret: "whsec_test",
  workflow_states: { todo: "s-todo", in_progress: "s-ip", done: "s-done", cancelled: "s-cancelled" },
}

const GITHUB = {
  owner: "first-fluke",
  repo: "agent-valley",
  token_env: "GITHUB_TOKEN",
  webhook_secret: "whsec_test",
  labels: { todo: "todo", in_progress: "doing", done: "done", cancelled: "cancelled" },
}

describe("comment relay configuration", () => {
  it("is off when the active tracker does not configure it", () => {
    expect(resolve({ linear: LINEAR }).commentRelay).toEqual({ enabled: false, ignoreAuthors: [] })
  })

  it("reads linear.comment_relay for the Linear tracker", () => {
    expect(resolve({ linear: { ...LINEAR, comment_relay: RELAY } }).commentRelay).toEqual({
      enabled: true,
      ignoreAuthors: ["release-bot"],
    })
  })

  it("reads github.comment_relay for the GitHub tracker and ignores the Linear block", () => {
    const config = resolve({
      tracker: { kind: "github" },
      linear: { ...LINEAR, comment_relay: { enabled: false } },
      github: { ...GITHUB, comment_relay: RELAY },
    })
    expect(config.commentRelay).toEqual({ enabled: true, ignoreAuthors: ["release-bot"] })
  })
})
