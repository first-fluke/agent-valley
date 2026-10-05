import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readlink, realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { runCommand } from "../workspace/worktree-lifecycle"
import { clearedGitEnvironment } from "./parallel-git"

/** Hash product files, including untracked deliverables, without commit timestamps or run receipts. */
export async function fingerprintWorkspace(workspacePath: string): Promise<string> {
  const root = await realpath(workspacePath)
  const files = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspacePath,
    env: clearedGitEnvironment,
  })
  if (files.exitCode !== 0)
    throw new Error(`Cannot inspect mission workspace: ${files.stderr}. Restore its Git metadata before resuming.`)
  const hash = createHash("sha256")
  for (const name of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    if (/^(?:\.agent-valley\/|\.agents\/(?:state|results)\/)/.test(name)) continue
    const path = resolve(workspacePath, name)
    if (!path.startsWith(`${resolve(workspacePath)}${sep}`))
      throw new Error("Git returned a path outside the mission workspace")
    hash.update(`${name}\0`)
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      hash.update("deleted\0")
      continue
    }
    const parent = await realpath(dirname(path))
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error(
        `Product path ${name} escapes the mission workspace through a directory symlink. Restore that directory before resuming.`,
      )
    }
    hash.update(`${stat.mode}\0`)
    if (stat.isSymbolicLink()) hash.update(await readlink(path))
    else if (stat.isFile()) {
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    } else if (stat.isDirectory()) {
      throw new Error(
        `Mission contains a submodule at ${name}. Use a repository without submodules for av order; nested product changes cannot yet be verified.`,
      )
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}
