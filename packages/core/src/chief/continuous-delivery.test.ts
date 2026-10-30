import { describe, expect, it, vi } from "vitest"
import { runContinuousOperation } from "./continuous-operation"
import { baseline, fixture, mission, operation } from "./continuous-operation.fixture"
import { executionPolicySchema } from "./execution"

describe("continuous delivery acceptance", () => {
  it.each(["pending", "blocked"] as const)(
    "does not accept a verified snapshot while delivery is %s",
    async (phase) => {
      const child = mission("child", "Improve source")
      child.executionPolicy = executionPolicySchema.parse({})
      child.execution = { startedAt: child.createdAt, runsStarted: 8, retries: 1 }
      child.codeDelivery = {
        policy: {
          branch: "main",
          remote: "origin",
          paths: ["allowed.ts"],
          message: "fix: deliver",
          baseSha: "a".repeat(40),
        },
        phase,
        attempts: 1,
        updatedAt: "2026-10-05T00:00:00.000Z",
      }
      const { record, ports, children } = fixture(
        operation({
          baseline: baseline(),
          cycleLimit: 1,
          phase: "running",
          currentMissionId: child.id,
          decision: { action: "execute", goal: child.goal, reason: "Saved decision", evidence: ["Saved source"] },
        }),
      )
      children.set(child.id, child)
      ports.runMission = vi.fn(async () => {
        if (!child.codeDelivery) throw new Error("Expected saved delivery")
        child.codeDelivery.phase = "unchanged"
        return child
      })
      const result = await runContinuousOperation(record, ports)
      expect(ports.runMission).toHaveBeenCalledTimes(phase === "pending" ? 1 : 0)
      expect(result.phase).toBe(phase === "pending" ? "completed" : "paused")
      expect(result.completedCycles).toBe(phase === "pending" ? 1 : 0)
      if (phase === "blocked") expect(ports.accept).not.toHaveBeenCalled()
    },
  )
})
