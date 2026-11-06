import { describe, expect, it } from "vitest"
import { mergeProviderHealthSnapshots, seedProviderHealthEvidence } from "./actor-health-seed"
import { providerHealthEvidenceSchema, type RouteEvidence } from "./operations"

const older = {
  consecutiveFailures: 2,
  lastOutcomeAt: "2026-11-06T10:00:00.000Z",
  cooldownUntil: "2026-11-06T10:20:00.000Z",
}
const recovered = { consecutiveFailures: 0, lastOutcomeAt: "2026-11-06T10:21:00.000Z" }

describe("operational provider health seeds", () => {
  it("keeps the newest outcome across saved snapshots without mutating either input", () => {
    const previous = [{ actorType: "qwen", providerHealth: older }]
    const update = [{ actorType: "qwen", providerHealth: recovered }]
    const before = structuredClone({ previous, update })
    const merged = mergeProviderHealthSnapshots(previous, update)
    expect(merged).toEqual(update)
    expect(mergeProviderHealthSnapshots(merged, previous)).toEqual(update)
    expect({ previous, update }).toEqual(before)
    expect(merged[0]?.providerHealth).not.toBe(recovered)
  })

  it("keeps native defaults and explicitly pinned models in separate health buckets", () => {
    expect(
      mergeProviderHealthSnapshots(
        [{ actorType: "qwen", providerHealth: older }],
        [{ actorType: "qwen", model: "pinned", providerHealth: recovered }],
      ),
    ).toEqual([
      { actorType: "qwen", providerHealth: older },
      { actorType: "qwen", model: "pinned", providerHealth: recovered },
    ])
  })

  it("carries health without quality, cost or business fields in the parent snapshot", () => {
    const route = {
      actorType: "qwen",
      samples: 7,
      successes: 4,
      totalCostUsd: 2,
      successfulDeliverableCostUsd: 0.5,
      providerHealth: older,
    }
    const snapshot = mergeProviderHealthSnapshots([], [route])
    expect(snapshot).toEqual([{ actorType: "qwen", providerHealth: older }])
    expect(providerHealthEvidenceSchema.parse(snapshot[0])).toEqual(snapshot[0])
    expect(providerHealthEvidenceSchema.safeParse(route).success).toBe(false)
  })

  it("joins newer health without adding or replacing measured quality and cost", () => {
    const quality: [RouteEvidence] = [
      {
        actorType: "qwen",
        samples: 7,
        successes: 4,
        totalCostUsd: 2,
        successfulDeliverableCostUsd: 0.5,
        providerHealth: older,
      },
    ]
    const before = structuredClone(quality)
    expect(seedProviderHealthEvidence(quality, [{ actorType: "qwen", providerHealth: recovered }])).toEqual([
      { ...quality[0], providerHealth: recovered },
    ])
    expect(quality).toEqual(before)
    expect(
      seedProviderHealthEvidence(
        [{ ...quality[0], providerHealth: recovered }],
        [{ actorType: "qwen", providerHealth: older }],
      )[0]?.providerHealth,
    ).toEqual(recovered)
  })

  it("adds a health-only route with no fabricated success or price evidence", () => {
    expect(seedProviderHealthEvidence([], [{ actorType: "qwen", providerHealth: older }])).toEqual([
      {
        actorType: "qwen",
        samples: 0,
        successes: 0,
        totalCostUsd: null,
        successfulDeliverableCostUsd: null,
        providerHealth: older,
      },
    ])
  })
})
