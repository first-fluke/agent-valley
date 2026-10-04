import { describe, expect, it } from "vitest"
import { makeIssue } from "../__tests__/characterization/helpers"
import { AGENT_TYPES } from "../domain/ledger"
import { actorDefaultsSchema, actorTypeSchema, routingRuleSchema, scoreRoutingSchema } from "./actor-schema"
import { resolveRouteWithScore } from "./routing"
import { globalConfigSchema, projectConfigSchema, resolveConfig } from "./yaml-loader"

describe("Qwen Actor configuration", () => {
  it("accepts canonical Actor defaults and preserves legacy field aliases", () => {
    expect(actorTypeSchema.options).toContain("qwen")
    expect(AGENT_TYPES).toContain("qwen")
    expect(actorDefaultsSchema.parse({ type: "qwen", model: "qwen-test-model" })).toEqual({
      type: "qwen",
      model: "qwen-test-model",
    })
    expect(globalConfigSchema.parse({ actor: { type: "qwen" }, agent: { type: "claude" } }).agent?.type).toBe("qwen")
    expect(projectConfigSchema.parse({ agent: { type: "qwen" } }).agent?.type).toBe("qwen")
  })
  it("resolves Qwen project defaults and canonical label/score routing", () => {
    const global = globalConfigSchema.parse({ actor: { type: "codex" } })
    const project = projectConfigSchema.parse({
      tracker: { kind: "github" },
      github: {
        owner: "test",
        repo: "repo",
        token_env: "GITHUB_TOKEN",
        webhook_secret: "test-secret",
        labels: { todo: "todo", in_progress: "doing", done: "done", cancelled: "cancelled" },
      },
      workspace: { root: "/workspace/repo" },
      actor: { type: "qwen", model: "qwen-test-model" },
      prompt: "Complete the requested issue",
      routing: {
        rules: [{ label: "qwen", workspace_root: "/workspace/route", actor_type: "qwen" }],
      },
      scoring: {
        routes: {
          easy: { min: 1, max: 3, actor: "qwen" },
          medium: { min: 4, max: 6, actor: "codex" },
          hard: { min: 7, max: 10, actor: "claude" },
        },
      },
    })
    const config = resolveConfig(global, project, { GITHUB_TOKEN: "test-only-token" })
    expect(config.agentType).toBe("qwen")
    expect(project.agent?.model).toBe("qwen-test-model")
    expect(resolveRouteWithScore(makeIssue({ labels: ["qwen"] }), config)).toMatchObject({
      agentType: "qwen",
      workspaceRoot: "/workspace/route",
    })
    expect(resolveRouteWithScore(makeIssue({ labels: [], score: 2 }), config)).toMatchObject({
      agentType: "qwen",
      matchedLabel: "score:2",
    })
  })
  it("accepts Qwen for routing rules and score tiers", () => {
    expect(routingRuleSchema.parse({ label: "qwen", workspace_root: "/work", actor_type: "qwen" }).agent_type).toBe(
      "qwen",
    )
    expect(
      scoreRoutingSchema.parse({
        easy: { min: 1, max: 3, actor: "qwen" },
        medium: { min: 4, max: 6, actor: "qwen" },
        hard: { min: 7, max: 10, actor: "qwen" },
      }).easy.agent,
    ).toBe("qwen")
  })
})
