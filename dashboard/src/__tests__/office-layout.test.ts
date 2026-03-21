import { describe, test, expect } from "bun:test"
import {
  TILE_SIZE,
  OFFICE_COLS,
  OFFICE_ROWS,
  OFFICE_WIDTH,
  OFFICE_HEIGHT,
  DESK_POSITIONS,
  FURNITURE_POSITIONS,
} from "../features/office/utils/office-layout"

describe("Office Layout", () => {
  test("dimensions are consistent", () => {
    expect(OFFICE_WIDTH).toBe(OFFICE_COLS * TILE_SIZE)
    expect(OFFICE_HEIGHT).toBe(OFFICE_ROWS * TILE_SIZE)
  })

  test("has 3 desk positions for 3 agent types", () => {
    expect(DESK_POSITIONS).toHaveLength(3)
  })

  test("desk labels match agent types", () => {
    const labels = DESK_POSITIONS.map((d) => d.label)
    expect(labels).toContain("Claude")
    expect(labels).toContain("Codex")
    expect(labels).toContain("Gemini")
  })

  test("desks are within office bounds", () => {
    for (const desk of DESK_POSITIONS) {
      expect(desk.col).toBeGreaterThanOrEqual(1)
      expect(desk.col).toBeLessThan(OFFICE_COLS - 1)
      expect(desk.row).toBeGreaterThanOrEqual(2)
      expect(desk.row).toBeLessThan(OFFICE_ROWS - 1)
    }
  })

  test("furniture positions are within office bounds", () => {
    for (const item of FURNITURE_POSITIONS) {
      expect(item.col).toBeGreaterThanOrEqual(0)
      expect(item.col).toBeLessThan(OFFICE_COLS)
      expect(item.row).toBeGreaterThanOrEqual(0)
      expect(item.row).toBeLessThan(OFFICE_ROWS)
    }
  })

  test("desks do not overlap", () => {
    const positions = DESK_POSITIONS.map((d) => `${d.col},${d.row}`)
    const unique = new Set(positions)
    expect(unique.size).toBe(positions.length)
  })
})
