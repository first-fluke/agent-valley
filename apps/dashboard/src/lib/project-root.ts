import { access } from "node:fs/promises"
import path from "node:path"

export async function resolveProjectRoot(startDir: string): Promise<string> {
  let current = startDir

  while (true) {
    try {
      await access(path.join(current, "WORKFLOW.md"))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        throw new Error(`WORKFLOW.md not found while walking up from ${startDir}`)
      }
      current = parent
    }
  }
}
