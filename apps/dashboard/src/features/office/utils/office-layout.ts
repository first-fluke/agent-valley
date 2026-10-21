export const TILE_SIZE = 32
export const OFFICE_ROWS = 12

export interface DeskPosition {
  col: number
  row: number
  label: string
}

export interface FurniturePosition {
  col: number
  row: number
  type: "coffee_machine" | "plant" | "server_rack" | "bathroom" | "gym" | "floor" | "wall"
}

export interface OfficeLayout {
  cols: number
  width: number
  height: number
  desks: DeskPosition[]
  furniture: FurniturePosition[]
  walkableTiles: { col: number; row: number }[]
  interestPoints: { col: number; row: number }[]
  coffeePoints: { col: number; row: number }[]
}

export function computeLayout(slotCount: number): OfficeLayout {
  const count = Math.max(1, slotCount)
  const deskArea = Math.max(16, (count - 1) * 4 + 6)
  const cols = deskArea + 6

  const desks: DeskPosition[] = []
  for (let i = 0; i < count; i++) {
    desks.push({ col: 5 + i * 4, row: 5, label: `Worker #${i + 1}` })
  }

  const furniture: FurniturePosition[] = []
  const interestPoints: { col: number; row: number }[] = []
  const coffeePoints: { col: number; row: number }[] = []

  // Gym — bottom-left
  const gymCol = 2
  const gymRow = 9
  furniture.push({ col: gymCol, row: gymRow, type: "gym" })
  interestPoints.push({ col: gymCol, row: gymRow - 1 })

  // ── Bathroom bump — sticks out BELOW bottom-right (2 rows) ──
  const bathCol = cols - 2
  furniture.push({ col: bathCol, row: OFFICE_ROWS - 1, type: "floor" }) // door (covers bottom wall)
  furniture.push({ col: bathCol - 1, row: OFFICE_ROWS, type: "wall" }) // left wall
  furniture.push({ col: bathCol, row: OFFICE_ROWS, type: "bathroom" }) // fixture
  furniture.push({ col: bathCol + 1, row: OFFICE_ROWS, type: "wall" }) // right wall
  furniture.push({ col: bathCol - 1, row: OFFICE_ROWS + 1, type: "wall" }) // bottom-left
  furniture.push({ col: bathCol, row: OFFICE_ROWS + 1, type: "wall" }) // bottom
  furniture.push({ col: bathCol + 1, row: OFFICE_ROWS + 1, type: "wall" }) // bottom-right
  interestPoints.push({ col: bathCol, row: OFFICE_ROWS - 1 }) // inside bathroom (door tile)

  // Fill extra rows with wall (hide background, except bathroom bump)
  const bathBumpSet = new Set([
    `${bathCol - 1},${OFFICE_ROWS}`,
    `${bathCol},${OFFICE_ROWS}`,
    `${bathCol + 1},${OFFICE_ROWS}`,
    `${bathCol - 1},${OFFICE_ROWS + 1}`,
    `${bathCol},${OFFICE_ROWS + 1}`,
    `${bathCol + 1},${OFFICE_ROWS + 1}`,
  ])
  for (let row = OFFICE_ROWS; row < OFFICE_ROWS + 2; row++) {
    for (let col = 0; col < cols; col++) {
      if (!bathBumpSet.has(`${col},${row}`)) {
        furniture.push({ col, row, type: "wall" })
      }
    }
  }

  // Coffee machine — top-left
  const coffeeCol = 2
  furniture.push({ col: coffeeCol, row: 1, type: "coffee_machine" })
  interestPoints.push({ col: coffeeCol, row: 2 })
  coffeePoints.push({ col: coffeeCol, row: 2 })

  // Coffee machine — top-right
  const coffeeCol2 = cols - 3
  furniture.push({ col: coffeeCol2, row: 1, type: "coffee_machine" })
  interestPoints.push({ col: coffeeCol2, row: 2 })
  coffeePoints.push({ col: coffeeCol2, row: 2 })

  // Top wall decorations
  const topSlots = Math.max(1, Math.floor((cols - 8) / 6))
  for (let i = 0; i < topSlots; i++) {
    const col = Math.min(6 + i * 6, cols - 3)
    furniture.push({
      col,
      row: 1,
      type: i % 2 === 0 ? "plant" : "server_rack",
    })
  }

  // Bottom floor plants (between gym and right wall)
  const plantStart = gymCol + 3
  const plantEnd = cols - 3
  const plantSpan = plantEnd - plantStart
  const plantCount = Math.max(0, Math.floor(plantSpan / 5))
  for (let i = 0; i < plantCount; i++) {
    const col = plantStart + Math.floor(((i + 1) * plantSpan) / (plantCount + 1))
    furniture.push({ col, row: 9, type: "plant" })
  }

  // Compute walkable tiles
  const blocked = new Set<string>()
  for (const f of furniture) blocked.add(`${f.col},${f.row}`)
  for (const d of desks) {
    blocked.add(`${d.col},${d.row - 1}`) // monitor
    blocked.add(`${d.col},${d.row}`) // desk
    blocked.add(`${d.col},${d.row + 1}`) // chair
  }
  // Un-block bathroom door tile (floor furniture covers wall visually, but agents walk here)
  blocked.delete(`${bathCol},${OFFICE_ROWS - 1}`)
  const walkableTiles: { col: number; row: number }[] = []
  for (let row = 2; row < OFFICE_ROWS - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      if (!blocked.has(`${col},${row}`)) walkableTiles.push({ col, row })
    }
  }
  // Manually add bathroom door tile (outside normal row range)
  walkableTiles.push({ col: bathCol, row: OFFICE_ROWS - 1 })

  return {
    cols,
    width: cols * TILE_SIZE,
    height: (OFFICE_ROWS + 2) * TILE_SIZE,
    desks,
    furniture,
    walkableTiles,
    interestPoints,
    coffeePoints,
  }
}
