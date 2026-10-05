import { describe, expect, it } from "vitest"
import {
  containerObservationPolicySchema,
  containerObservationSnapshotSchema,
  containerTargetHealthy,
} from "./container-observation-policy"
import { validateContainerObservation } from "./container-observation-state"

const target = { id: "service", kind: "docker", container: "api", context: "orbstack" }
const fingerprint = "a".repeat(64)
const healthy = {
  targetId: "service",
  kind: "docker" as const,
  status: "collected" as const,
  state: "running" as const,
  ready: true,
  logsAvailable: true,
  issues: [],
  fingerprint,
}
const snapshot = {
  collectedAt: "2026-10-06T00:00:00Z",
  nextPollAt: "2026-10-06T00:00:30Z",
  fingerprint,
  results: [healthy],
}

describe("pinned container observation boundary", () => {
  it("defaults to bounded read-only monitoring and accepts explicit Docker and Kubernetes contexts", () => {
    expect(containerObservationPolicySchema.parse({ targets: [target] })).toMatchObject({
      enabled: true,
      poll_interval_sec: 30,
      timeout_ms: 10_000,
      max_output_bytes: 65_536,
      log_tail: 50,
      log_since_sec: 300,
    })
    expect(
      containerObservationPolicySchema.safeParse({
        targets: [
          {
            id: "pod",
            kind: "kubernetes",
            namespace: "prod",
            pod: "api-123",
            container: "api",
            context: "gke_project_location_cluster",
          },
        ],
      }).success,
    ).toBe(true)
  })

  it("rejects flag injection, arbitrary commands, duplicate IDs and out-of-bound resource controls", () => {
    for (const value of [
      { targets: [{ ...target, container: "--all" }] },
      { targets: [{ ...target, context: "--host=evil" }] },
      { targets: [target, target] },
      { targets: [] },
      { targets: [target], command: "docker restart api" },
      { targets: [target], timeout_ms: 60_001 },
      { targets: [target], log_tail: 201 },
      { targets: [target], max_output_bytes: 1_048_577 },
      { targets: [target], memory_percent_threshold: 101 },
      { targets: [target], cpu_percent_threshold: Number.NaN },
      { targets: [{ id: "pod", kind: "kubernetes", namespace: "--all", pod: "api;exec", container: "api" }] },
    ])
      expect(containerObservationPolicySchema.safeParse(value).success).toBe(false)
  })

  it("requires exact configured target IDs and kinds, complete availability and future scheduling", () => {
    const policy = containerObservationPolicySchema.parse({ targets: [target] })
    expect(validateContainerObservation(policy, snapshot)).toEqual(snapshot)
    for (const value of [
      { ...snapshot, results: [] },
      { ...snapshot, results: [healthy, healthy] },
      { ...snapshot, results: [{ ...healthy, targetId: "other" }] },
      { ...snapshot, results: [{ ...healthy, kind: "kubernetes" }] },
      { ...snapshot, nextPollAt: snapshot.collectedAt },
    ])
      expect(() => validateContainerObservation(policy, value)).toThrow()
    expect(() => validateContainerObservation(undefined, snapshot)).toThrow("pinned")
  })

  it("strictly limits persisted evidence and treats missing required sources as unresolved", () => {
    expect(containerTargetHealthy(healthy)).toBe(true)
    for (const result of [
      { ...healthy, status: "unavailable" as const },
      { ...healthy, ready: false },
      { ...healthy, logsAvailable: false },
      { ...healthy, statsAvailable: false },
      { ...healthy, issues: ["log-error" as const] },
    ])
      expect(containerTargetHealthy(result)).toBe(false)
    expect(
      containerObservationSnapshotSchema.safeParse({
        ...snapshot,
        results: [{ ...healthy, env: { SECRET: "invalid" } }],
      }).success,
    ).toBe(false)
    expect(
      containerObservationSnapshotSchema.safeParse({
        ...snapshot,
        results: [{ ...healthy, logExcerpt: "x".repeat(8_193) }],
      }).success,
    ).toBe(false)
    expect(
      validateContainerObservation(containerObservationPolicySchema.parse({ enabled: false, targets: [target] }), {
        ...snapshot,
        results: [],
      }).results,
    ).toEqual([])
  })
})
