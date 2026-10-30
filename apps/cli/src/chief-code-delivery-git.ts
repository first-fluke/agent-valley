import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { codeDeliveryPath } from "@agent-valley/core/chief/code-delivery-contract"
import { clearedGitEnvironment } from "@agent-valley/core/util/git-environment"
import { GIT_SAFETY_ARGS } from "@agent-valley/core/workspace/worktree-lifecycle"

const execute = promisify(execFile)

export async function gitRead(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const result = await execute("git", [...GIT_SAFETY_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...clearedGitEnvironment, ...env },
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    })
    return result.stdout
  } catch {
    throw new Error("Code delivery Git command failed. Preserve the source workspace and repair Git before retrying.")
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function canonicalDirectory(path: string, description: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`Use an absolute ${description} path before preparing code delivery.`)
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error(`The ${description} must be a real directory. Restore its original location before retrying.`)
  return realpath(path)
}

async function inspectProductPath(workspace: string, path: string): Promise<void> {
  if (!codeDeliveryPath(path))
    throw new Error(`Code delivery path ${JSON.stringify(path)} is private or invalid. Select an exact product file.`)
  const destination = resolve(workspace, path)
  const within = relative(workspace, destination)
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("Code delivery escaped its source workspace. Restore the pinned product paths before retrying.")
  const parts = path.split("/")
  let current = workspace
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] ?? "")
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!entry) return
    if (entry.isSymbolicLink() || (await realpath(current)) !== current)
      throw new Error(`Code delivery path ${JSON.stringify(path)} redirects. Replace symbolic links before retrying.`)
    if (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())
      throw new Error(`Code delivery path ${JSON.stringify(path)} is not a regular file. Select product files only.`)
  }
}

async function changedProductPaths(workspace: string, baseSha: string): Promise<string[]> {
  const tracked = await gitRead(workspace, [
    "diff",
    "--name-only",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    baseSha,
    "--",
  ])
  const untracked = await gitRead(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort()
}

export async function prepareDeliveryPatch(
  workspace: string,
  baseSha: string,
  allowedPaths: string[],
  directory: string,
): Promise<{ treeSha: string; patchSha256: string; changedPaths: string[]; patchPath: string }> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))
    throw new Error("Use the pinned full base commit SHA before preparing code delivery.")
  if (allowedPaths.some((path) => !codeDeliveryPath(path)))
    throw new Error("Select exact product paths for code delivery; private and runtime paths cannot be delivered.")
  workspace = await canonicalDirectory(workspace, "source workspace")
  directory = await canonicalDirectory(directory, "private delivery directory")
  const top = (await gitRead(workspace, ["rev-parse", "--show-toplevel"])).trim()
  if ((await realpath(top)) !== workspace)
    throw new Error("Use the source repository root as the delivery workspace before retrying.")
  const changedPaths = await changedProductPaths(workspace, baseSha)
  const allowed = new Set(allowedPaths)
  for (const path of changedPaths) {
    if (!allowed.has(path))
      throw new Error(
        `Changed path ${JSON.stringify(path)} is outside code delivery scope. Reconcile the exact allowlist.`,
      )
    await inspectProductPath(workspace, path)
  }
  const temporary = await mkdtemp(join(directory, "patch-"))
  const indexPath = join(temporary, "index")
  const patchPath = join(temporary, "delivery.patch")
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    await gitRead(workspace, ["read-tree", baseSha], env)
    if (changedPaths.length) await gitRead(workspace, ["--literal-pathspecs", "add", "-A", "--", ...changedPaths], env)
    for (const path of changedPaths) await inspectProductPath(workspace, path)
    const latest = await changedProductPaths(workspace, baseSha)
    if (JSON.stringify(latest) !== JSON.stringify(changedPaths))
      throw new Error("Source delivery paths changed during capture. Preserve the edits and refresh verification.")
    const patch = await gitRead(
      workspace,
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        baseSha,
        "--",
      ],
      env,
    )
    const treeSha = (await gitRead(workspace, ["write-tree"], env)).trim()
    await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return { treeSha, patchSha256: createHash("sha256").update(patch).digest("hex"), changedPaths, patchPath }
  } finally {
    await rm(indexPath, { force: true })
    await rm(`${indexPath}.lock`, { force: true })
  }
}
