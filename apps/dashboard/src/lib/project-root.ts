import { access } from "node:fs/promises"
import path from "node:path"
import { resolveProjectConfigPath } from "@agent-valley/core/config/project-config-path"

export async function resolveProjectRoot(startDir: string): Promise<string> {
  let current = startDir

  while (true) {
    try {
      await access(resolveProjectConfigPath(current))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        throw new Error(
          `av.yaml not found while walking up from ${startDir}. Run av setup in your project directory to create av.yaml, then run av up there.`,
        )
      }
      current = parent
    }
  }
}
