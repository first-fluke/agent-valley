/**
 * Hardware detection — detect system resources and recommend MAX_PARALLEL.
 *
 * Estimation per agent session:
 *   - RAM: ~4 GB (Claude Code is heaviest, Codex/Antigravity/Cursor/Grok lighter)
 *   - CPU: ~2 logical cores
 *
 * Recommendation = min(RAM-based, CPU-based), clamped to [1, cpuCount].
 */

import { cpus, totalmem } from "node:os"

export interface HardwareInfo {
  cpuCores: number
  totalMemoryGB: number
  recommended: number
}

const RAM_PER_AGENT_GB = 4
const CORES_PER_AGENT = 2

export function detectHardware(): HardwareInfo {
  const cpuCores = cpus().length
  const totalMemoryGB = Math.floor(totalmem() / 1024 ** 3)

  const byRam = Math.floor(totalMemoryGB / RAM_PER_AGENT_GB)
  const byCpu = Math.floor(cpuCores / CORES_PER_AGENT)

  const recommended = Math.max(1, Math.min(byRam, byCpu))

  return { cpuCores, totalMemoryGB, recommended }
}
