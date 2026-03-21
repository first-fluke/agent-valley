import { describe, test, expect } from "bun:test"
import { STATE_ANIMATION_MAP } from "../features/office/utils/animations"
import type { WorkspaceStatus } from "../features/office/types/agent"

describe("STATE_ANIMATION_MAP", () => {
  const statuses: WorkspaceStatus[] = ["idle", "running", "done", "failed"]

  test("has entries for all workspace statuses", () => {
    for (const status of statuses) {
      expect(STATE_ANIMATION_MAP[status]).toBeDefined()
    }
  })

  test("each entry has required animation config fields", () => {
    for (const status of statuses) {
      const config = STATE_ANIMATION_MAP[status]
      expect(config).toHaveProperty("name")
      expect(config).toHaveProperty("frameCount")
      expect(config).toHaveProperty("speed")
      expect(config).toHaveProperty("loop")
      expect(typeof config.name).toBe("string")
      expect(config.frameCount).toBeGreaterThan(0)
      expect(config.speed).toBeGreaterThan(0)
      expect(typeof config.loop).toBe("boolean")
    }
  })

  test("idle and running animations loop", () => {
    expect(STATE_ANIMATION_MAP.idle.loop).toBe(true)
    expect(STATE_ANIMATION_MAP.running.loop).toBe(true)
  })

  test("done animation does not loop", () => {
    expect(STATE_ANIMATION_MAP.done.loop).toBe(false)
  })
})
