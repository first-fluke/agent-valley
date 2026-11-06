import { describe, expect, it, vi } from "vitest"
import type { AgentAvailability } from "../agent-discovery"
import { discoverReadyAgents, resetHandoffForRetry } from "../chief-agent-discovery"

describe("handoff Actor discovery", () => {
  it("returns installed and authenticated CLIs without including unknown or unavailable credentials", async () => {
    const availability: AgentAvailability[] = [
      { agentType: "claude", binaryPath: "/bin/claude", readiness: "ready", reason: "OAuth found" },
      { agentType: "codex", binaryPath: "/bin/codex", readiness: "ready", reason: "API credentials found" },
      { agentType: "cursor", binaryPath: "/bin/cursor", readiness: "unknown", reason: "Cannot inspect auth" },
      { agentType: "qwen", binaryPath: "/bin/qwen", readiness: "unauthenticated", reason: "Sign in required" },
      { agentType: "kimi", readiness: "unavailable", reason: "CLI missing" },
      { agentType: "grok", readiness: "ready", reason: "Missing installation evidence" },
      { agentType: "opencode", binaryPath: " ", readiness: "ready", reason: "Empty installation evidence" },
    ]
    const discover = vi.fn(async () => availability)

    await expect(discoverReadyAgents(discover)).resolves.toEqual(["claude", "codex"])
    expect(discover).toHaveBeenCalledOnce()
  })

  it("refreshes readiness on each request and deduplicates the returned vendor pool", async () => {
    const discover = vi
      .fn<() => Promise<AgentAvailability[]>>()
      .mockResolvedValueOnce([
        { agentType: "claude", binaryPath: "/bin/claude", readiness: "ready", reason: "OAuth found" },
        { agentType: "claude", binaryPath: "/other/claude", readiness: "ready", reason: "OAuth found" },
      ])
      .mockResolvedValueOnce([
        { agentType: "claude", binaryPath: "/bin/claude", readiness: "unauthenticated", reason: "Signed out" },
      ])

    await expect(discoverReadyAgents(discover)).resolves.toEqual(["claude"])
    await expect(discoverReadyAgents(discover)).resolves.toEqual([])
  })

  it("propagates discovery errors rather than claiming an authenticated candidate exists", async () => {
    await expect(
      discoverReadyAgents(async () => {
        throw new Error("Authentication inspection failed")
      }),
    ).rejects.toThrow("Authentication inspection failed")
  })
})

describe("explicit handoff retry", () => {
  const checkpoint = () => ({
    handoff: {
      exhaustedAgents: ["claude" as const],
      routes: { chief: { agentType: "codex" as const } },
      continuations: { "chief:plan": 1 as const },
    },
    execution: { runsStarted: 9, retries: 2, startedAt: "2026-11-06T00:00:00.000Z" },
    executionPolicy: { maxRuns: 20, maxEstimatedCostUsd: 5 },
    supervision: { rounds: 3, stalledRounds: 1, maxRounds: 8 },
    repairRound: 2,
    operations: { runs: [{ runId: "spent-run", costUsd: 1.5 }] },
    tasks: [{ id: "external", effectState: "unknown" }],
    history: [{ stage: "handoff", message: "claude -> codex" }],
  })

  it("retries original routes after allowance recovery while retaining spent limits and uncertain effects", () => {
    const mission = checkpoint()
    const { handoff: _handoff, ...retained } = structuredClone(mission)

    resetHandoffForRetry(mission, true)

    expect(mission).not.toHaveProperty("handoff")
    expect(mission).toEqual(retained)
  })

  it.each([undefined, false])(
    "preserves exhausted providers and continuation bounds on automatic resume (%s)",
    (retry) => {
      const mission = checkpoint()
      const saved = structuredClone(mission)

      resetHandoffForRetry(mission, retry)

      expect(mission).toEqual(saved)
    },
  )
})
