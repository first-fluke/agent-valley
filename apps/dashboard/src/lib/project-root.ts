import { access } from "node:fs/promises"
import path from "node:path"

export async function resolveProjectRoot(startDir: string): Promise<string> {
  let current = startDir

  while (true) {
    try {
      await access(path.join(current, "valley.yaml"))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        throw new Error(
          `valley.yaml not found while walking up from ${startDir}. Run av setup in your project directory to create valley.yaml, then run av up there.`,
        )
      }
      current = parent
    }
  }
}
