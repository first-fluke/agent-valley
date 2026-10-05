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

  it("inherits container targets or replaces the entire policy with explicit project settings", () => {
    const global = globalConfigSchema.parse({
      chief: {
        memory: false,
        container_observation: { targets: [{ id: "api", kind: "docker", container: "app-api", context: "orbstack" }] },
      },
    })
    const inherited = mergeChiefConfig(global.chief, { review_vendor: "require" })
    expect(inherited.container_observation).toMatchObject({
      enabled: true,
      poll_interval_sec: 30,
      log_tail: 50,
      log_since_sec: 300,
      targets: [{ id: "api", kind: "docker", container: "app-api", context: "orbstack" }],
    })
    const project = projectConfigSchema.parse({
      chief: {
        container_observation: {
          enabled: false,
          poll_interval_sec: 60,
          targets: [{ id: "worker", kind: "kubernetes", namespace: "app", pod: "worker-abc", container: "worker" }],
        },
      },
    })
    const overridden = mergeChiefConfig(global.chief, project.chief)
    expect(overridden.memory).toBe(false)
    expect(overridden.container_observation).toEqual(project.chief?.container_observation)
    expect(overridden.container_observation?.targets).toHaveLength(1)
    expect(overridden.container_observation?.enabled).toBe(false)
  })

  it.each([
    { targets: [] },
    { targets: [{ id: "api", kind: "docker", container: "--all" }] },
    { targets: [{ id: "api", kind: "docker", container: "app", context: "https://user:secret@example.test" }] },
    { targets: [{ id: "api", kind: "docker", container: "app" }], command: "docker restart app" },
    { targets: [{ id: "worker", kind: "kubernetes", pod: "worker", container: "app" }] },
    { targets: [{ id: "api", kind: "docker", container: "app" }], poll_interval_sec: 0 },
  ])("rejects incomplete, untargeted or command-bearing container policies: %j", (container_observation) => {
    const result = projectConfigSchema.safeParse({ chief: { container_observation } })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Invalid container policy unexpectedly accepted")
    expect(result.error.issues[0]?.path.slice(0, 2)).toEqual(["chief", "container_observation"])
  })
})
