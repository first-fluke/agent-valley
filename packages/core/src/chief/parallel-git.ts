import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { ParallelBaseline } from "./parallel-contract"

const exec = promisify(execFile)
export const productPaths = ["--", ".", ":(exclude,glob).agent-valley/**", ":(exclude,glob).agents/**"]
export const excludedParallelPath = (path: string) => /^(?:\.agent-valley|\.agents)(?:\/|$)/.test(path)
export const clearedGitEnvironment = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_LITERAL_PATHSPECS: undefined,
  GIT_GLOB_PATHSPECS: undefined,
  GIT_NOGLOB_PATHSPECS: undefined,
  GIT_ICASE_PATHSPECS: undefined,
}
export async function parallelGit(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<string> {
  try {
    const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fileMode=true", ...args], {
      cwd,
      env: { ...process.env, ...clearedGitEnvironment, ...env },
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    })
    return result.stdout
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    throw new Error(
      `Parallel Git operation failed: ${failure.stderr?.trim() || failure.message}. Preserve task worktrees and repair Git before resuming.`,
    )
  }
}
export async function parallelRoot(workspace: string): Promise<string> {
  const root = await realpath(workspace)
  const directory = join(root, ".agent-valley", "parallel")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await realpath(directory)
  if (actual !== directory)
    throw new Error("Parallel task storage escapes the mission worktree. Restore .agent-valley as a local directory.")
  return actual
}
export function assertParallelPath(root: string, path: string): void {
  const local = relative(root, resolve(path))
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(root, local) !== resolve(path))
    throw new Error("Parallel task artifacts must remain within the mission's private parallel directory.")
}
export async function writeParallelJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
/** A private index includes tracked changes, deletions, executable bits and nonignored untracked files. */
export async function captureParallelBaseline(workspace: string): Promise<ParallelBaseline> {
  const directory = await parallelRoot(workspace)
  const index = join(directory, `index-${randomUUID()}`)
  const pathsFile = `${index}.paths`
  const env = { GIT_INDEX_FILE: index }
  try {
    const head = (await parallelGit(workspace, ["rev-parse", "HEAD"])).trim()
    const tracked = await parallelGit(workspace, ["ls-tree", "-r", "--name-only", "-z", head])
    const visible = await parallelGit(workspace, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    const paths = [...new Set(`${tracked}${visible}`.split("\0"))].filter((path) => path && !excludedParallelPath(path))
    await parallelGit(workspace, ["read-tree", head], env)
    if (paths.length) {
      await writeFile(pathsFile, `${paths.join("\0")}\0`, { flag: "wx", mode: 0o600 })
      // Force applies only to enumerated tracked/nonignored files, including files tracked despite ignore rules.
      await parallelGit(workspace, ["add", "-A", "-f", `--pathspec-from-file=${pathsFile}`, "--pathspec-file-nul"], {
        ...env,
        GIT_LITERAL_PATHSPECS: "1",
      })
    }
    const tree = (await parallelGit(workspace, ["write-tree"], env)).trim()
    if ((await parallelGit(workspace, ["rev-parse", "HEAD"])).trim() !== head)
      throw new Error("Mission HEAD changed during its parallel snapshot. Retry after the worktree settles.")
    return { head, tree }
  } finally {
    await rm(pathsFile, { force: true })
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
}
export async function parallelTreeImages(workspace: string, tree: string) {
  const entries = new Map<string, { mode: "100644" | "100755" | "120000"; oid: string }>()
  for (const line of (await parallelGit(workspace, ["ls-tree", "-r", "-z", tree])).split("\0")) {
    if (!line) continue
    const tab = line.indexOf("\t")
    const [mode, type, oid] = line.slice(0, tab).split(" ")
    const path = line.slice(tab + 1)
    if (excludedParallelPath(path)) continue
    if (type !== "blob" || !oid || !["100644", "100755", "120000"].includes(mode ?? ""))
      throw new Error(
        `Parallel task path ${path} is not a regular file or symlink. Remove unsupported submodules before running parallel Actors.`,
      )
    entries.set(path, { mode: mode as "100644" | "100755" | "120000", oid })
  }
  return entries
}
