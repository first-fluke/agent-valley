import { describe, expect, it } from "vitest"
import { chiefCapturePolicy, chiefConfigSchema, chiefOperatingPolicy, mergeChiefConfig } from "./chief-schema"
import { globalConfigSchema, projectConfigSchema } from "./yaml-loader"

describe("Chief policy configuration", () => {
  it("merges global policy with project overrides and resolves canonical runtime contracts", () => {
    const global = globalConfigSchema.parse({
      chief: {
        memory: false,
        review_vendor: "require",
        routing: {
          candidates: [{ actor_type: "codex", model: "cheap", input_per_million_usd: 1, output_per_million_usd: 2 }],
        },
      },
    })
    const project = projectConfigSchema.parse({
      chief: {
        review_vendor: "prefer",
        capture: { enabled: true, target_url: "http://localhost:3000" },
        reporting: {
          destinations: [{ id: "team", channel: "slack", token_env: "SLACK_TOKEN", channel_id_env: "SLACK_CHANNEL" }],
        },
      },
    })
    const config = mergeChiefConfig(global.chief, project.chief)
    expect(chiefOperatingPolicy(config, ["codex"])).toMatchObject({
      memory: false,
      reviewVendor: "prefer",
      readyActors: ["codex"],
      routing: { minSamples: 3, minSuccessRate: 0.8, candidates: [{ actorType: "codex", inputPerMillionUsd: 1 }] },
    })
    expect(chiefCapturePolicy(config)).toMatchObject({ enabled: true, targetUrl: "http://localhost:3000", video: true })
    expect(config.reporting?.destinations[0]?.channel).toBe("slack")
  })
  it("rejects literal secrets, duplicate destinations and untargeted recordings", () => {
    expect(() =>
      chiefConfigSchema.parse({
        reporting: { destinations: [{ id: "a", channel: "slack", token_env: "xoxb-secret" }] },
      }),
    ).toThrow("environment variable")
    expect(() =>
      chiefConfigSchema.parse({
        reporting: {
          destinations: [
            { id: "a", channel: "slack" },
            { id: "a", channel: "discord" },
          ],
        },
      }),
    ).toThrow("unique")
    expect(() => chiefConfigSchema.parse({ capture: { enabled: true } })).toThrow("target_url")
  })
})
