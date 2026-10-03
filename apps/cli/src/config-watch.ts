import { resolve } from "node:path"
import { PROJECT_CONFIG_FILENAME } from "@agent-valley/core/config/project-config-path"
import type { FSWatcher } from "chokidar"

export async function watchConfig(
  root: string,
  globalPath: string,
  onChange: (path: string) => void,
): Promise<FSWatcher> {
  const { watch } = await import("chokidar")
  const watcher = watch([resolve(root, PROJECT_CONFIG_FILENAME), globalPath], { ignoreInitial: true })
  watcher.on("all", (event, path) => {
    if (["add", "change", "unlink"].includes(event)) onChange(path)
  })
  return watcher
}
