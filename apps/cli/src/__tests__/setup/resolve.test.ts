import { describe, expect, it } from "vitest"
import { resolveContext } from "../../setup/resolve"

describe("resolveContext (linear)", () => {
  const validLinearCtx = {
    trackerKind: "linear" as const,
    linear: {
      apiKey: "lin_api_key",
      teams: [],
      orgUrlKey: "acme",
      teamUuid: "uuid-1",
      selectedTeam: { id: "uuid-1", key: "ACR", name: "Acme" },
      states: [],
      todoStateId: "t",
      inProgressStateId: "ip",
      doneStateId: "d",
      cancelledStateId: "c",
      webhookSecret: "lin_wh_sec",
    },
    workspaceRoot: "/ws",
    agentType: "claude" as const,
    maxParallel: 3,
  }

  it("returns ok when all linear fields are present", () => {
    const result = resolveContext(validLinearCtx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ctx.trackerKind).toBe("linear")
      expect(result.ctx.linear.selectedTeam.key).toBe("ACR")
    }
  })

  it("reports missing fields with a 5-field error", () => {
    const result = resolveContext({ trackerKind: "linear", linear: { apiKey: "k" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("code: setup.context.incomplete")
      expect(result.error).toContain('"missing":')
      expect(result.error).toContain("linear.teamUuid")
      expect(result.error).toContain("linear.webhookSecret")
      expect(result.error).toContain("fix:")
      expect(result.error).toContain("retryable: true")
    }
  })
})

describe("resolveContext (github)", () => {
  const validGithubCtx = {
    trackerKind: "github" as const,
    github: {
      token: "ghp_xxx",
      tokenEnv: "GITHUB_TOKEN",
      owner: "o",
      repo: "r",
      webhookSecret: "whsec_aaaaaaaaaaaaaaaa",
      labels: { todo: "v:todo", inProgress: "v:wip", done: "v:done", cancelled: "v:cancelled" },
    },
    workspaceRoot: "/ws",
    agentType: "claude" as const,
    maxParallel: 2,
  }

  it("returns ok when all github fields are present", () => {
    const result = resolveContext(validGithubCtx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ctx.trackerKind).toBe("github")
      expect(result.ctx.github.tokenEnv).toBe("GITHUB_TOKEN")
    }
  })

  it("flags every missing github subfield", () => {
    const result = resolveContext({
      trackerKind: "github",
      workspaceRoot: "/ws",
      agentType: "claude",
      maxParallel: 2,
      github: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      for (const f of [
        "github.token",
        "github.tokenEnv",
        "github.owner",
        "github.repo",
        "github.webhookSecret",
        "github.labels.todo",
        "github.labels.inProgress",
        "github.labels.done",
        "github.labels.cancelled",
      ]) {
        expect(result.error).toContain(f)
      }
    }
  })
})
