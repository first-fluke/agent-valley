export const TILE_SIZE = 32
export const OFFICE_COLS = 16
export const OFFICE_ROWS = 12
export const OFFICE_WIDTH = OFFICE_COLS * TILE_SIZE
export const OFFICE_HEIGHT = OFFICE_ROWS * TILE_SIZE

export interface DeskPosition {
  col: number
  row: number
  label: string
}

export const DESK_POSITIONS: DeskPosition[] = [
  { col: 3, row: 5, label: "Claude" },
  { col: 7, row: 5, label: "Codex" },
  { col: 11, row: 5, label: "Gemini" },
]

export const FURNITURE_POSITIONS = [
  { col: 1, row: 1, type: "coffee_machine" as const },
  { col: 5, row: 1, type: "plant" as const },
  { col: 13, row: 1, type: "server_rack" as const },
  { col: 6, row: 9, type: "plant" as const },
  { col: 10, row: 9, type: "plant" as const },
]
