/**
 * One-time import of the `.agent-valley/*.json` snapshots that preceded
 * the SQLite state database. The file is renamed `<name>.migrated` after
 * import so an older build cannot resurrect stale state, and a meta flag
 * keeps the import from running twice.
 */

import { rename, stat } from "node:fs/promises"
import { logger } from "../observability/logger"
import type { StateDatabase } from "./state-database"

export async function importLegacySnapshot(
  db: StateDatabase,
  name: string,
  path: string | undefined,
  importer: () => Promise<void>,
): Promise<void> {
  if (!path) return
  const flag = `imported:${name}`
  if ((await db.getMeta(flag)) === "1") return
  const present = await stat(path).then(
    () => true,
    () => false,
  )
  if (present) {
    try {
      await importer()
      await rename(path, `${path}.migrated`)
      logger.info("state", `Imported legacy ${name} snapshot into the state database`, { path })
    } catch (err) {
      // Leave the file and the flag alone so the next boot tries again.
      logger.error("state", `Failed to import legacy ${name} snapshot`, { path, error: String(err) })
      return
    }
  }
  await db.write([db.setMetaStatement(flag, "1")])
}
