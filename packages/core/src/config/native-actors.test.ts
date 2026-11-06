import { describe, expect, it } from "vitest"
import { handoffRouteSchema, handoffStateSchema } from "../chief/handoff-contract"
import { AGENT_IDS } from "../domain/agent"
import { AGENT_TYPES } from "../domain/ledger"
import { actorTypeSchema, routingRuleSchema, scoreRoutingSchema } from "./actor-schema"
import { globalConfigSchema, projectConfigSchema } from "./yaml-loader"

describe.each(["qwen", "dsh", "zcode"] as const)("%s Actor configuration", (type) => {
  it("accepts the same Actor identity in defaults, routing, ledger and Chief handoff", () => {
    expect(actorTypeSchema.parse(type)).toBe(type)
    expect(AGENT_TYPES).toContain(type)
    expect(globalConfigSchema.parse({ actor: { type }, agent: { type: "claude" } }).agent?.type).toBe(type)
    expect(projectConfigSchema.parse({ actor: { type } }).agent?.type).toBe(type)
    expect(routingRuleSchema.parse({ label: "native", workspace_root: "/work", actor_type: type }).agent_type).toBe(
      type,
    )
    expect(handoffRouteSchema.parse({ agentType: type })).toEqual({ agentType: type })
    expect(
      scoreRoutingSchema.parse({
        easy: { min: 1, max: 3, actor: type },
        medium: { min: 4, max: 6, actor: type },
        hard: { min: 7, max: 10, actor: type },
      }).hard.agent,
    ).toBe(type)
  })
})

it("retains every unavailable provider in a durable handoff after all Actors are exhausted", () => {
  const state = {
    exhaustedAgents: [...AGENT_IDS],
    unavailableAgents: [...AGENT_IDS],
    routes: { worker: { agentType: "dsh" }, reviewer: { agentType: "zcode" } },
    continuations: {},
  }
  expect(handoffStateSchema.parse(state)).toEqual(state)
})
