import { mkdtempSync, rmSync } from "node:fs"
import { chmod, lstat, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, isAbsolute, join, relative, resolve } from "node:path"
import { resolveBinaryPath } from "@agent-valley/core/sessions/sandbox-binary"
import {
  type ProvisioningResult,
  runOfficialInstaller,
  runTerminalCommand,
  type TerminalCommand,
  type TerminalCommandResult,
} from "./agent-provisioning"

const INSTALLER_URL = "https://raw.githubusercontent.com/first-fluke/oh-my-agent/main/cli/install.sh"
const DOCUMENTATION_URL = "https://github.com/first-fluke/oh-my-agent"
const LATEST_PACKAGE = "oh-my-agent@latest"

export interface OmaProvisioningDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  resolveBinary: (name: string) => string | null
  runCommand: (command: TerminalCommand) => Promise<TerminalCommandResult>
  makeTempDir: () => string
  removeTempDir: (path: string) => void
}

function defaults(): OmaProvisioningDeps {
  const home = homedir()
  return {
    platform: process.platform,
    home,
    env: process.env,
    resolveBinary: (name) =>
      resolveBinaryPath(
        name,
        name === "bun" ? [join(process.env.BUN_INSTALL ?? join(home, ".bun"), "bin", "bun")] : [],
      ),
    runCommand: runTerminalCommand,
    makeTempDir: () => mkdtempSync(join(tmpdir(), "av-oma-install-")),
    removeTempDir: (path) => rmSync(path, { recursive: true, force: true }),
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function installedVersion(skills: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await readFile(join(skills, "_version.json"), "utf8")) as Record<string, unknown>
    return marker.schemaVersion === 2 &&
      marker.mode === "project" &&
      typeof marker.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(marker.version)
      ? marker.version
      : null
  } catch {
    return null
  }
}

const CUSTOM_CONFIG_NAMES = [
  "oma-config.yaml",
  "oma-config.cue",
  "oma-config.local.yaml",
  "oma-config.local.cue",
  "mcp.json",
  "mcp_config.json",
]

async function snapshotConfig(agents: string) {
  const snapshots: { path: string; bytes: Buffer; mode: number }[] = []
  for (const name of CUSTOM_CONFIG_NAMES) {
    const path = join(agents, name)
    if (!(await present(path))) continue
    const file = await lstat(path)
    if (!file.isFile()) throw new Error("Custom configuration must be a project-local regular file.")
    snapshots.push({ path, bytes: await readFile(path), mode: file.mode & 0o777 })
  }
  return snapshots
}

async function restoreConfig(agents: string, snapshots: Awaited<ReturnType<typeof snapshotConfig>>) {
  for (const file of snapshots) {
    await writeFile(file.path, file.bytes, { mode: file.mode })
    await chmod(file.path, file.mode)
  }
  const original = new Set(snapshots.map((file) => file.path))
  for (const pair of [
    ["oma-config.yaml", "oma-config.cue"],
    ["oma-config.local.yaml", "oma-config.local.cue"],
  ]) {
    if (!pair.some((name) => original.has(join(agents, name)))) continue
    for (const name of pair) {
      const path = join(agents, name)
      if (!original.has(path))
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
    }
  }
}

async function workspacePath(input: string): Promise<string | null> {
  if (!input.trim() || !isAbsolute(input)) return null
  const root = resolve(input)
  if (!(await directory(root))) return null
  for (const path of [join(root, ".agents"), join(root, ".agents", "skills")]) {
    if (!(await present(path))) continue
    const actual = await realpath(path)
    const location = relative(await realpath(root), actual)
    if (
      location === ".." ||
      location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(location)
    )
      return null
  }
  return root
}

/** Read installed project metadata and skill files without executing OMA or making network calls. */
export async function inspectOma(
  workspaceRoot: string,
  _overrides: Partial<OmaProvisioningDeps> = {},
): Promise<ProvisioningResult> {
  try {
    const root = await workspacePath(workspaceRoot)
    if (!root) return { success: false, message: "Choose an existing absolute workspace with project-local OMA files." }
    const skills = join(root, ".agents", "skills")
    const version = await installedVersion(skills)
    if (!version) throw new Error("Invalid installed metadata")
    const entries = (await readdir(skills, { withFileTypes: true })).filter((entry) =>
      /^oma-[a-z0-9-]+$/.test(entry.name),
    )
    if (!entries.length) throw new Error("No installed skills")
    for (const entry of entries) {
      if (!entry.isDirectory() || !(await lstat(join(skills, entry.name, "SKILL.md"))).isFile())
        throw new Error("Incomplete installed skill")
    }
    return {
      success: true,
      message: `OMA ${version} is installed with ${entries.length} project skills. Prepare updates it to the latest full skill pack.`,
    }
  } catch {
    return {
      success: false,
      message:
        "Project OMA installation is missing or incomplete. Prepare installs the latest full skill pack while preserving custom configuration.",
    }
  }
}

function failure(action: string, result?: TerminalCommandResult): ProvisioningResult {
  return {
    success: false,
    message: `${action} ${result?.failure === "timed_out" ? "timed out" : "did not complete"}. Retry OMA preparation or follow ${DOCUMENTATION_URL}.`,
  }
}

/** Bootstrap prerequisites, update the official latest CLI, then install the full skill pack in the selected workspace. */
export async function prepareOma(
  workspaceRoot: string,
  overrides: Partial<OmaProvisioningDeps> = {},
): Promise<ProvisioningResult> {
  const deps = { ...defaults(), ...overrides }
  try {
    const root = await workspacePath(workspaceRoot)
    if (!root) return { success: false, message: "Choose an existing absolute workspace with project-local OMA files." }
    if (deps.platform === "win32")
      return {
        success: false,
        message: `Prepare OMA inside WSL, then recheck the selected workspace. ${DOCUMENTATION_URL}`,
      }
    const bootstrap = await runOfficialInstaller(INSTALLER_URL, deps, {
      cwd: root,
      env: { ...deps.env, OMA_INSTALL_NO_RUN: "1" },
    })
    if (!bootstrap.success)
      return bootstrap.stage === "prerequisites"
        ? { success: false, message: `Install curl and bash, then retry OMA preparation. ${DOCUMENTATION_URL}` }
        : failure("OMA prerequisite preparation", bootstrap)
    const bun = deps.resolveBinary("bun")
    if (!bun)
      return {
        success: false,
        message: `Bun was not found after OMA bootstrap. Add Bun to PATH and retry. ${DOCUMENTATION_URL}`,
      }
    const environment = { ...deps.env }
    delete environment.OMA_INSTALL_NO_RUN
    delete environment.OMA_YES
    environment.CI = "true"
    const paths = [
      deps.env.BUN_INSTALL_BIN ?? join(deps.env.BUN_INSTALL ?? join(deps.home, ".bun"), "bin"),
      join(deps.home, ".local", "bin"),
    ]
    environment.PATH = [...new Set([...paths, ...(environment.PATH ?? "").split(delimiter).filter(Boolean)])].join(
      delimiter,
    )
    const request = { command: bun, env: environment, cwd: root, timeoutMs: 300_000 }
    const latest = await deps.runCommand({ ...request, args: ["install", "--global", LATEST_PACKAGE] })
    if (!latest.success) return failure("OMA CLI update", latest)
    const agents = join(root, ".agents")
    const existing =
      (await installedVersion(join(agents, "skills"))) !== null ||
      ((await directory(join(agents, "skills"))) &&
        ((await present(join(agents, "oma-config.yaml"))) ||
          (await present(join(agents, "mcp.json"))) ||
          (await directory(join(agents, "workflows")))))
    const custom = await snapshotConfig(agents)
    // CI defaults install non-interactively; --yes would also opt into an upstream GitHub star.
    const args = existing ? ["update", "--yes", "--with-new-skills", "--all"] : ["install"]
    let installed: TerminalCommandResult
    try {
      installed = await deps.runCommand({ ...request, args: ["x", "--bun", LATEST_PACKAGE, ...args] })
    } finally {
      if (custom.length) await restoreConfig(agents, custom)
    }
    if (!installed.success) return failure(existing ? "OMA skill update" : "OMA skill installation", installed)
    const inspection = await inspectOma(root, deps)
    if (!inspection.success)
      return {
        success: false,
        message:
          "OMA command finished, but installed project metadata or skills could not be verified. Retry preparation in the selected workspace.",
      }
    deps.env.PATH = environment.PATH
    return {
      success: true,
      message: `Latest official OMA preparation completed. ${inspection.message.split(" Prepare ")[0]}`,
    }
  } catch {
    return failure("OMA preparation")
  }
}
