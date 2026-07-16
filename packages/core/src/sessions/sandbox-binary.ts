/**
 * sandbox-binary.ts — Portable "is this binary installed" check.
 *
 * Deliberately avoids Bun-specific globals (e.g. `Bun.which`) because
 * this module is exercised from vitest, which may run its worker pool
 * under plain Node.js even when the outer process was launched via
 * `bun run`. `node:fs` + `process.env.PATH` work identically under both
 * runtimes.
 */

import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"

/**
 * Resolve a binary by name. Checks `candidateAbsolutePaths` first (fast,
 * covers well-known install locations), then falls back to scanning
 * `PATH`. Returns the resolved absolute path, or `null` if not found.
 */
export function resolveBinaryPath(name: string, candidateAbsolutePaths: string[] = []): string | null {
  for (const candidate of candidateAbsolutePaths) {
    if (existsSync(candidate)) return candidate
  }

  const pathEnv = process.env.PATH ?? ""
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }

  return null
}
