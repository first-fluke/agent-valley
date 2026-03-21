import { describe, test, expect } from "bun:test"
import {
  TILE_SIZE,
  OFFICE_ROWS,
  computeLayout,
} from "../features/office/utils/office-layout"

describe("Office Layout", () => {
  test("dimensions are consistent", () => {
    const layout = computeLayout(3)
    expect(layout.width).toBe(layout.cols * TILE_SIZE)
    expect(layout.height).toBe(OFFICE_ROWS * TILE_SIZE)
  })

  test("desk count matches requested slots", () => {
    expect(computeLayout(3).desks).toHaveLength(3)
    expect(computeLayout(5).desks).toHaveLength(5)
    expect(computeLayout(1).desks).toHaveLength(1)
  })

  test("office widens for more desks", () => {
    const small = computeLayout(3)
    const large = computeLayout(5)
    expect(large.cols).toBeGreaterThan(small.cols)
  })

  test("desks are within office bounds", () => {
    for (const count of [1, 3, 5, 8]) {
      const layout = computeLayout(count)
      for (const desk of layout.desks) {
        expect(desk.col).toBeGreaterThanOrEqual(1)
        expect(desk.col).toBeLessThan(layout.cols - 1)
        expect(desk.row).toBeGreaterThanOrEqual(2)
        expect(desk.row).toBeLessThan(OFFICE_ROWS - 1)
      }
    }
  })

  test("furniture positions are within office bounds", () => {
    for (const count of [1, 3, 5]) {
      const layout = computeLayout(count)
      for (const item of layout.furniture) {
        expect(item.col).toBeGreaterThanOrEqual(0)
        expect(item.col).toBeLessThan(layout.cols)
        expect(item.row).toBeGreaterThanOrEqual(0)
        expect(item.row).toBeLessThan(OFFICE_ROWS)
      }
    }
  })

  test("desks do not overlap", () => {
    const layout = computeLayout(5)
    const positions = layout.desks.map((d) => `${d.col},${d.row}`)
    const unique = new Set(positions)
    expect(unique.size).toBe(positions.length)
  })

  test("walkable tiles exclude desks and furniture", () => {
    const layout = computeLayout(3)
    const walkableSet = new Set(layout.walkableTiles.map((t) => `${t.col},${t.row}`))
    for (const desk of layout.desks) {
      expect(walkableSet.has(`${desk.col},${desk.row}`)).toBe(false)
    }
  })

  test("has interest points for gym, bathroom, and coffee", () => {
    const layout = computeLayout(3)
    expect(layout.interestPoints.length).toBeGreaterThanOrEqual(3)
  })
})
