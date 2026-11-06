import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { clearedGitEnvironment } from "../util/git-environment"
import { runCommand } from "./command"

export interface RuntimeIgnoreChange {
  path: string
  before: string | null
  after: string
  mode: number
}

const entry = ".agent-valley/"
const gitOptions = { env: { ...clearedGitEnvironment, LC_ALL: "C" } }

function failure(path: string): Error {
  return new Error(
    `Cannot prepare AV runtime exclusion in ${path}. Restore a writable, regular .gitignore file without a symbolic link, retain its existing rules, then retry.`,
  )
}

/** Plan a repository-local rule without changing setup's atomic file transaction. */
export async function prepareRuntimeGitignore(root: string): Promise<RuntimeIgnoreChange | undefined> {
  let directory: string
  try {
    directory = await realpath(resolve(root))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw failure(join(resolve(root), ".gitignore"))
  }
  const git = await runCommand("git", ["rev-parse", "--show-toplevel"], { ...gitOptions, cwd: directory })
  if (git.exitCode !== 0) {
    if (/not a git repository/i.test(git.stderr)) return undefined
    throw new Error(
      `Cannot inspect Git ownership for ${directory}. Restore readable Git metadata and Git on PATH, then retry AV.`,
    )
  }
  const repository = await realpath(git.stdout.trim())
  const local = relative(repository, directory)
  if (local === ".." || local.startsWith(`..${sep}`))
    throw new Error(
      `Git worktree ownership for ${directory} points outside its project. Restore its original Git metadata before starting AV.`,
    )
  if (directory === resolve(homedir())) return undefined
  const path = join(directory, ".gitignore")
  let before: string | null = null
  let mode = 0o644
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw failure(path)
    mode = info.mode & 0o777
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      before = await file.readFile("utf8")
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(path)
  }
  const lines = new Set((before ?? "").split(/\r?\n/))
  if (lines.has(entry) || lines.has(`/${entry}`)) {
    const ignored = await runCommand(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", ".agent-valley/__av_runtime_ignore_probe__"],
      { ...gitOptions, cwd: directory },
    )
    if (ignored.exitCode === 0) return undefined
    if (ignored.exitCode !== 1) throw failure(path)
  }
  if (!(mode & 0o222)) throw failure(path)
  const newline = before?.includes("\r\n") ? "\r\n" : "\n"
  return {
    path,
    before,
    after: `${before ?? ""}${before && !before.endsWith("\n") ? newline : ""}${entry}${newline}`,
    mode,
  }
}

/** Append only AV's rule; existing content and already tracked runtime files remain untouched. */
export async function ensureRuntimeGitignore(root: string): Promise<boolean> {
  const change = await prepareRuntimeGitignore(root)
  if (!change) return false
  try {
    const file = await open(
      change.path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      change.mode,
    )
    try {
      if (!(await file.stat()).isFile()) throw failure(change.path)
      const current = await file.readFile("utf8")
      if (current !== (change.before ?? ""))
        throw new Error(
          `The .gitignore file changed while AV prepared ${change.path}. Retain those edits and retry; nothing was overwritten.`,
        )
      await file.writeFile(change.after.slice((change.before ?? "").length))
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The .gitignore file changed")) throw error
    throw failure(change.path)
  }
  return true
}
