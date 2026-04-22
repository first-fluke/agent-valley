/**
 * Small UI helpers shared by every step. Keeping picocolors/clack
 * wrapping out of the step modules lets us swap the TUI layer later
 * without touching step logic.
 */

import pc from "picocolors"

export function stepLabel(current: number, total: number, label: string): string {
  return `${pc.dim(`[${current}/${total}]`)} ${label}`
}
