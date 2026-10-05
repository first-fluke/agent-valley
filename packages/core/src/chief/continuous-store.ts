import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type Operation, operationIdSchema, operationSchema } from "./continuous-contract"
import { MissionStore } from "./store"

export class ContinuousOperationStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    operationIdSchema.parse(id)
    return join(this.directory, `${id}.json`)
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await realpath(this.directory)) !== resolve(this.directory))
      throw new Error(
        "Operation storage redirects through a symlink. Restore its original local directory before resuming.",
      )
  }

  save(operation: Operation): Promise<void> {
    const snapshot = operationSchema.parse(operation)
    const write = this.writes.then(() => this.persist(snapshot))
    this.writes = write.catch(() => {})
    return write
  }

  private async persist(operation: Operation): Promise<void> {
    const path = this.path(operation.id)
    await this.ensureDirectory()
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, operation }, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async load(id: string): Promise<Operation> {
    const path = this.path(id)
    if ((await realpath(this.directory)) !== resolve(this.directory) || !(await lstat(path)).isFile())
      throw new Error("Operation record must remain a regular file in its original local storage directory.")
    const content = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; operation?: unknown }
    if (content.version !== 1)
      throw new Error("Unsupported operation record version. Use the AV version that created this operation.")
    const operation = operationSchema.parse(content.operation)
    if (operation.id !== id)
      throw new Error("Operation file identity does not match its filename. Restore the original record.")
    return operation
  }

  async list(): Promise<Operation[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => this.load(name.slice(0, -5))),
    )
  }

  async lock(id: string): Promise<() => Promise<void>> {
    this.path(id)
    await this.ensureDirectory()
    return new MissionStore(this.directory).lock(id)
  }
}
