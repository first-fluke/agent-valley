import { describe, expect, it } from "vitest"
import { actorDefaultsSchema, scoreRoutingSchema } from "./actor-schema"
import { globalConfigSchema, projectConfigSchema, resolveConfig } from "./yaml-loader"

const projectBase = {
  tracker: { kind: "github" as const },
  github: {
    owner: "fixture",
    repo: "fixture",
    webhook_secret: "synthetic",
    labels: { todo: "todo", in_progress: "doing", done: "done", cancelled: "cancelled" },
  },
  workspace: { root: "/tmp/fixture" },
  prompt: "Complete the assigned work.",
}

describe("Actor configuration normalization", () => {
  it.each([globalConfigSchema, projectConfigSchema])(
    "normalizes canonical Actor defaults for existing consumers",
    (schema) => {
      const config = schema.parse({ actor: { type: "codex", model: " selected-model ", timeout: 120 } })
      expect(config.actor).toEqual({ type: "codex", model: "selected-model", timeout: 120 })
      expect(config.agent).toEqual(config.actor)
    },
  )

  it.each([globalConfigSchema, projectConfigSchema])("continues reading legacy agent defaults", (schema) => {
    const config = schema.parse({ agent: { type: "claude", model: "legacy-model" } })
    expect(config.agent).toEqual({ type: "claude", model: "legacy-model" })
    expect(config.actor).toBeUndefined()
  })

  it.each([globalConfigSchema, projectConfigSchema])(
    "uses the whole canonical block without mixing legacy model pins",
    (schema) => {
      const config = schema.parse({
        actor: { type: "kimi" },
        agent: { type: "codex", model: "codex-only", timeout: 240 },
      })
      expect(config.agent).toEqual({ type: "kimi" })
    },
  )

  it("keeps schema fields available to the setup repair parser", () => {
    expect(globalConfigSchema.shape.actor).toBeDefined()
    expect(globalConfigSchema.shape.agent).toBeDefined()
  })

  it("rejects invalid Actor models and types at the boundary", () => {
    expect(() => globalConfigSchema.parse({ actor: { model: " " } })).toThrow()
    expect(() => projectConfigSchema.parse({ actor: { type: "unknown" } })).toThrow()
    expect(actorDefaultsSchema.safeParse({ timeout: 29 }).success).toBe(false)
  })

  it("resolves canonical project/global Actor values through the existing runtime fields", () => {
    const global = globalConfigSchema.parse({ actor: { type: "claude", timeout: 240 } })
    const project = projectConfigSchema.parse({ ...projectBase, actor: { type: "codex", max_parallel: 1 } })
    const config = resolveConfig(global, project, { GITHUB_TOKEN: "synthetic" })
    expect(config).toMatchObject({ agentType: "codex", agentTimeout: 240, maxParallel: 1 })
  })

  it("also supports directly supplied canonical blocks when resolving runtime configuration", () => {
    const config = resolveConfig(
      { actor: { timeout: 240 } },
      { ...projectBase, actor: { type: "kimi" } },
      {
        GITHUB_TOKEN: "synthetic",
      },
    )
    expect(config).toMatchObject({ agentType: "kimi", agentTimeout: 240 })
  })

  it("prefers routing actor_type while preserving legacy rules", () => {
    const project = projectConfigSchema.parse({
      ...projectBase,
      routing: {
        rules: [
          { label: "canonical", workspace_root: "/tmp/canonical", actor_type: "kimi", agent_type: "codex" },
          { label: "legacy", workspace_root: "/tmp/legacy", agent_type: "claude" },
        ],
      },
    })
    expect(project.routing?.rules?.map((rule) => rule.agent_type)).toEqual(["kimi", "claude"])
    expect(
      resolveConfig(null, project, { GITHUB_TOKEN: "synthetic" }).routingRules.map((rule) => rule.agentType),
    ).toEqual(["kimi", "claude"])
  })

  it("normalizes canonical score actors and keeps legacy score tiers", () => {
    const routes = scoreRoutingSchema.parse({
      easy: { min: 1, max: 3, actor: "kimi", agent: "codex" },
      medium: { min: 4, max: 6, agent: "claude" },
      hard: { min: 7, max: 10, actor: "codex" },
    })
    expect([routes.easy.agent, routes.medium.agent, routes.hard.agent]).toEqual(["kimi", "claude", "codex"])
    const project = projectConfigSchema.parse({ ...projectBase, scoring: { routes } })
    expect(resolveConfig(null, project, { GITHUB_TOKEN: "synthetic" }).scoreRouting?.easy.agent).toBe("kimi")
  })

  it("requires an actor in every score tier and retains range validation", () => {
    const routes = {
      easy: { min: 1, max: 3, actor: "kimi" },
      medium: { min: 4, max: 6, actor: "claude" },
      hard: { min: 7, max: 10, actor: "codex" },
    }
    expect(scoreRoutingSchema.safeParse({ ...routes, easy: { min: 1, max: 3 } }).success).toBe(false)
    expect(scoreRoutingSchema.safeParse({ ...routes, easy: { min: 4, max: 3, actor: "kimi" } }).success).toBe(false)
    expect(scoreRoutingSchema.safeParse({ ...routes, easy: { min: 1, max: 5, actor: "kimi" } }).success).toBe(false)
  })
})
