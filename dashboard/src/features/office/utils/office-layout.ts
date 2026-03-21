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
}

export function computeLayout(slotCount: number): OfficeLayout {
  const count = Math.max(1, slotCount)
  // Extra margin for gym (left) and bathroom (right)
  const deskArea = Math.max(16, (count - 1) * 4 + 6)
  const cols = deskArea + 6

  const desks: DeskPosition[] = []
  for (let i = 0; i < count; i++) {
    desks.push({ col: 5 + i * 4, row: 5, label: `Worker #${i + 1}` })
  }

  const furniture: FurniturePosition[] = []
  const interestPoints: { col: number; row: number }[] = []

  // Gym — bottom-left
  const gymCol = 2
  const gymRow = 9
  furniture.push({ col: gymCol, row: gymRow, type: "gym" })
  interestPoints.push({ col: gymCol, row: gymRow - 1 })

  // Bathroom — bottom-right
  const bathroomCol = cols - 3
  const bathroomRow = 9
  furniture.push({ col: bathroomCol, row: bathroomRow, type: "bathroom" })
  interestPoints.push({ col: bathroomCol, row: bathroomRow - 1 })

  // Coffee machine — top-left
  const coffeeCol = 2
  furniture.push({ col: coffeeCol, row: 1, type: "coffee_machine" })
  interestPoints.push({ col: coffeeCol, row: 2 })

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

  // Bottom floor plants (between gym and bathroom)
  const plantStart = gymCol + 3
  const plantEnd = bathroomCol - 2
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
    blocked.add(`${d.col},${d.row}`)     // desk
    blocked.add(`${d.col},${d.row + 1}`) // chair
  }
  const walkableTiles: { col: number; row: number }[] = []
  for (let row = 2; row < OFFICE_ROWS - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      if (!blocked.has(`${col},${row}`)) walkableTiles.push({ col, row })
    }
  }

  return {
    cols,
    width: cols * TILE_SIZE,
    height: OFFICE_ROWS * TILE_SIZE,
    desks,
    furniture,
    walkableTiles,
    interestPoints,
  }
}
