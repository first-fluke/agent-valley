import { describe, expect, it } from "vitest"
import { chiefOperatingPolicySchema, operatingRunSchema } from "../chief/operations"
import { gateReviewSchema } from "../chief/review-gates"
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

  it("keeps review gates unset unless configured and allows project settings to replace inherited gates", () => {
    const unset = chiefOperatingPolicy(chiefConfigSchema.parse({}), ["codex"])
    expect(unset.reviewGates).toBeUndefined()
    expect(JSON.parse(JSON.stringify(unset))).not.toHaveProperty("reviewGates")

    const global = globalConfigSchema.parse({
      chief: { review_gates: [{ id: "security", instructions: "Check authorization and secret handling." }] },
    })
    const inherited = chiefOperatingPolicy(mergeChiefConfig(global.chief, { memory: false }), ["codex"])
    expect(inherited.reviewGates).toEqual(global.chief?.review_gates)
    const project = projectConfigSchema.parse({ chief: { review_gates: [] } })
    expect(chiefOperatingPolicy(mergeChiefConfig(global.chief, project.chief), ["codex"]).reviewGates).toEqual([])
  })

  it("maps configured review gates into a serializable immutable operating policy", () => {
    const project = projectConfigSchema.parse({
      chief: {
        review_gates: [
          { id: "security", instructions: "  Check authorization and secret handling.  " },
          { id: "accessibility", instructions: "Check keyboard access." },
        ],
      },
    })
    const policy = chiefOperatingPolicy(mergeChiefConfig(undefined, project.chief), ["codex", "claude"])
    expect(policy.reviewGates).toEqual([
      { id: "security", instructions: "Check authorization and secret handling." },
      { id: "accessibility", instructions: "Check keyboard access." },
    ])
    expect(chiefOperatingPolicySchema.parse(JSON.parse(JSON.stringify(policy)))).toEqual(policy)
  })

  it("accepts at most eight review gates with unique bounded IDs", () => {
    const gates = Array.from({ length: 8 }, (_, index) => ({
      id: `gate-${index}`,
      instructions: "Inspect the result.",
    }))
    expect(chiefConfigSchema.parse({ review_gates: gates }).review_gates).toHaveLength(8)
    expect(() =>
      chiefConfigSchema.parse({ review_gates: [...gates, { id: "ninth", instructions: "Inspect." }] }),
    ).toThrow()
    expect(() => chiefConfigSchema.parse({ review_gates: [gates[0], gates[0]] })).toThrow("unique")
    expect(() =>
      chiefOperatingPolicySchema.parse({ reviewVendor: "prefer", memory: true, reviewGates: [gates[0], gates[0]] }),
    ).toThrow("unique")
    expect(
      chiefConfigSchema.parse({ review_gates: [{ id: "a".repeat(64), instructions: "Inspect." }] }).review_gates,
    ).toHaveLength(1)
  })

  it.each(["", "-security", "security/review", "security review", "a".repeat(65)])(
    "rejects an invalid review gate ID %j at the configuration boundary",
    (id) => {
      const parsed = projectConfigSchema.safeParse({ chief: { review_gates: [{ id, instructions: "Inspect." }] } })
      expect(parsed.success).toBe(false)
      if (parsed.success) throw new Error("Invalid review gate ID unexpectedly accepted")
      expect(parsed.error.issues[0]?.path).toEqual(["chief", "review_gates", 0, "id"])
    },
  )

  it.each([" ", "x".repeat(32_001)])("rejects missing or oversized review gate instructions", (instructions) => {
    expect(() => chiefConfigSchema.parse({ review_gates: [{ id: "security", instructions }] })).toThrow()
  })

  it("stores gate review evidence with the existing actionable-review contract and rejects unknown fields", () => {
    const evidence = {
      gateId: "security",
      taskId: "fix-login",
      reviewerId: "reviewer",
      fingerprint: "a".repeat(64),
      review: { passed: true, summary: "No security issues found.", findings: [] },
    }
    expect(gateReviewSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence)
    expect(operatingRunSchema.shape.stage.parse("gate-review")).toBe("gate-review")
    expect(() =>
      gateReviewSchema.parse({ ...evidence, review: { ...evidence.review, findings: ["Fix access control."] } }),
    ).toThrow("unresolved findings")
    expect(() =>
      chiefConfigSchema.parse({ review_gates: [{ id: "security", instructions: "Inspect.", command: "run" }] }),
    ).toThrow()
    expect(() => gateReviewSchema.parse({ ...evidence, approved: true })).toThrow()
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
