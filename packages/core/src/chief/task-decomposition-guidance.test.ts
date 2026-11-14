import { describe, expect, it } from "vitest"
import { taskDecompositionGuidance } from "./task-decomposition-guidance"
import type { Mission } from "./types"

const mission = (maxParallel?: number) =>
  ({ executionPolicy: maxParallel === undefined ? undefined : { maxParallel } }) as unknown as Mission

describe("task decomposition guidance", () => {
  it("tells the planner that single-task waves leave parallel slots idle", () => {
    const guidance = taskDecompositionGuidance(mission(3), "plan")
    expect(guidance).toContain("Up to 3 ready tasks run at once")
    expect(guidance).toContain("disjoint owned paths")
    expect(guidance).toContain("name that delivered file or interface")
    expect(taskDecompositionGuidance(mission(3), "replan")).toContain("Up to 3 ready tasks run at once")
  })

  it("omits the wave guidance for sequential missions and Actor work", () => {
    expect(taskDecompositionGuidance(mission(1), "plan")).not.toContain("ready tasks run at once")
    expect(taskDecompositionGuidance(mission(), "plan")).not.toContain("ready tasks run at once")
    expect(taskDecompositionGuidance(mission(3), "work")).not.toContain("ready tasks run at once")
  })
})
