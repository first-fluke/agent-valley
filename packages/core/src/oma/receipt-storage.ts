import { createHash } from "node:crypto"
import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const OMA_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OmaReceiptStorageOptions {
  env?: NodeJS.ProcessEnv
  home?: string
}

function absolutePath(value: string, key: string): string {
  if (
    !isAbsolute(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error(`${key} must be an absolute path without control characters`)
  return resolve(value)
}

/** OMA 17's project state contract; inspect only the selected profile and project. */
export function omaReceiptDirectories(workspace: string, options: OmaReceiptStorageOptions = {}): string[] {
  const env = options.env ?? process.env
  const profile = env.OMA_PROFILE ?? "0"
  if (!/^(0|[1-9][0-9]{0,9})$/.test(profile)) throw new Error("OMA_PROFILE must be a non-negative profile number")
  const stateHome =
    env.OMA_STATE_HOME === undefined
      ? absolutePath(env.OMA_HOME || join(options.home ?? homedir(), ".oma"), "OMA_HOME")
      : absolutePath(env.OMA_STATE_HOME, "OMA_STATE_HOME")
  const project = createHash("sha256")
    .update(realpathSync(resolve(workspace)))
    .digest("hex")
  return [
    join(stateHome, "u", profile, "projects", project, "agent-runs"),
    ...(profile === "0" ? [join(resolve(workspace), ".agents", "state", "agent-runs")] : []),
  ]
}

function regularDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("OMA receipt directory is not a regular directory")
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function validateDirectory(directory: string, workspace: string): boolean {
  if (!regularDirectory(directory)) return false
  // A configured home may have a canonical system alias; its profile/project descendants must not redirect reads.
  const legacy = join(resolve(workspace), ".agents", "state", "agent-runs")
  const boundary = directory === legacy ? resolve(workspace) : dirname(dirname(dirname(dirname(dirname(directory)))))
  const components = relative(boundary, directory).split(sep).filter(Boolean)
  let path = boundary
  for (const component of components) {
    path = join(path, component)
    if (!regularDirectory(path)) throw new Error("OMA receipt directory changed during inspection")
  }
  return true
}

export function listOmaRunFiles(workspace: string, options: OmaReceiptStorageOptions = {}): string[] {
  return omaReceiptDirectories(workspace, options).flatMap((directory) => {
    if (!validateDirectory(directory, workspace)) return []
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && OMA_RUN_ID.test(name.slice(0, -5)))
      .map((name) => join(directory, name))
  })
}

/** Bare UUID filenames remain supported by injected legacy fixture/adapters. */
export function resolveOmaReceiptPath(
  workspace: string,
  entry: string,
  options: OmaReceiptStorageOptions = {},
): string {
  const name = basename(entry)
  if (!name.endsWith(".json") || !OMA_RUN_ID.test(name.slice(0, -5))) throw new Error("Invalid receipt filename")
  if (entry === name) return join(resolve(workspace), ".agents", "state", "agent-runs", name)
  if (!isAbsolute(entry) || resolve(entry) !== entry) throw new Error("Invalid receipt path")
  if (!omaReceiptDirectories(workspace, options).includes(dirname(entry)))
    throw new Error("OMA receipt is outside the selected project/profile")
  if (!validateDirectory(dirname(entry), workspace)) throw new Error("OMA receipt directory is missing")
  return entry
}
