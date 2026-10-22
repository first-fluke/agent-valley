import { mkdir, readdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { writeJsonAtomic } from "../util/atomic-json"
import { lockRecord } from "../util/record-lock"
import { type A2aJob, a2aJobSchema } from "./a2a-job"

/** Durable AV execution state; a repository lock prevents competing local artifact writers. */
export class A2aJobStore {
  readonly directory: string
  private writes: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {
    this.directory = join(root, ".agent-valley", "a2a")
  }

  async prepare(): Promise<void> {
    const parent = join(this.root, ".agent-valley")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if ((await realpath(parent)) !== parent)
      throw new Error("A2A storage must stay inside its repository. Restore .agent-valley as a local directory.")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await realpath(this.directory)) !== this.directory)
      throw new Error("A2A storage must be a local directory. Restore .agent-valley/a2a before running or resuming.")
  }

  async lock(): Promise<() => Promise<void>> {
    await this.prepare()
    return lockRecord(join(this.directory, "repository.lock"), "A2A repository execution")
  }

  save(job: A2aJob): Promise<void> {
    const write = this.writes.then(async () => {
      await this.prepare()
      const value = a2aJobSchema.parse(job)
      if (value.root !== this.root)
        throw new Error("A2A record belongs to another repository. Restore its original root.")
      await writeJsonAtomic(this.path(value.id), value)
    })
    this.writes = write.catch(() => {})
    return write
  }

  async load(id: string): Promise<A2aJob> {
    await this.prepare()
    const job = a2aJobSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")))
    if (job.id !== id || job.root !== this.root)
      throw new Error("A2A record identity differs from its filename or repository. Restore the original record.")
    return job
  }

  async list(): Promise<A2aJob[]> {
    await this.prepare()
    return Promise.all(
      (await readdir(this.directory))
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .sort()
        .map((name) => this.load(name.slice(0, -5))),
    )
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new Error("Invalid A2A execution ID. Use the ID printed by av a2a run or av a2a status.")
    return join(this.directory, `${id}.json`)
  }
}
