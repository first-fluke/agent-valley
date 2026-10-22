import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"

/** Serialize durable record owners; stale recovery itself has a separate exclusive guard. */
export async function lockRecord(path: string, label: string, kind = label): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600)
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, token }))
      } finally {
        await file.close()
      }
      return async () => {
        const current = JSON.parse(await readFile(path, "utf8")) as { token?: string }
        if (current.token === token) await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await reclaim(path, label, kind)
    }
  }
  throw new Error(`Could not acquire ${label}. Another process acquired it; retry after it stops.`)
}

async function reclaim(path: string, label: string, kind: string): Promise<void> {
  const guardPath = `${path}.reclaim`
  const guard = await open(guardPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
    throw new Error(
      `${label} lock recovery is already in progress. Retry later; inspect ${guardPath} and remove it only after its owner has stopped.`,
    )
  })
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid }))
    const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (content === null) return
    const lock = JSON.parse(content) as { pid?: number }
    if (!Number.isInteger(lock.pid) || (lock.pid ?? 0) < 2)
      throw new Error(`Invalid ${kind} lock at ${path}. Inspect it before removing it.`)
    try {
      process.kill(lock.pid as number, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      await unlink(path)
      return
    }
    throw new Error(`${label} is already running (PID ${lock.pid}). Stop that run before resuming.`)
  } finally {
    await guard.close()
    await unlink(guardPath)
  }
}
