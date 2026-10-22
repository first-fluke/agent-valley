import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import { clearedGitEnvironment } from "../util/git-environment"
import { fingerprintWorkspace } from "../workspace/fingerprint"

const exec = promisify(execFile)

export async function a2aGit(root: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      env: { ...process.env, ...clearedGitEnvironment },
      maxBuffer: 8 * 1024 * 1024,
    })
    return result.stdout
  } catch {
    throw new Error("Cannot inspect the selected A2A repository. Restore its Git metadata before running or resuming.")
  }
}

export async function a2aRepository(root: string) {
  if (!isAbsolute(root)) throw new Error("Set --workspace to an absolute Git repository root.")
  const canonical = await realpath(root)
  const top = await realpath((await a2aGit(canonical, ["rev-parse", "--show-toplevel"])).trim())
  if (top !== canonical) throw new Error("Set --workspace to the Git repository root, not a subdirectory.")
  const gitDirectory = await realpath(
    resolve(canonical, (await a2aGit(canonical, ["rev-parse", "--git-common-dir"])).trim()),
  )
  return {
    root: canonical,
    repositoryId: createHash("sha256").update(`${canonical}\0${gitDirectory}`).digest("hex"),
    baseRevision: (await a2aGit(canonical, ["rev-parse", "HEAD"])).trim(),
    branch: (await a2aGit(canonical, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
  }
}

export async function assertA2aClean(root: string): Promise<string> {
  const status = await a2aGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude,glob).agent-valley/**",
    ":(exclude,glob).agents/state/**",
    ":(exclude,glob).agents/results/**",
  ])
  if (status)
    throw new Error("A2A execution requires a clean repository. Commit or preserve existing changes before starting.")
  return fingerprintWorkspace(root)
}
