import { constants } from "node:fs"
import { access, lstat, readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

const channelName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const hostTriple = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+){2,5}$/

function toolchainChannel(source: string, legacy: boolean): string | undefined {
  const lines = source.split(/\r?\n/).map((line) => line.trim())
  const meaningful = lines.filter((line) => line && !line.startsWith("#"))
  if (legacy && meaningful.length === 1 && channelName.test(meaningful[0] ?? "")) return meaningful[0]
  let inToolchain = false
  let seenToolchain = false
  let channel: string | undefined
  for (const line of meaningful) {
    const section = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (section) {
      inToolchain = section[1] === "toolchain"
      if (inToolchain && seenToolchain) return
      if (inToolchain) seenToolchain = true
    } else if (inToolchain && /^path\s*=/.test(line)) return
    else if (inToolchain && /^channel\s*=/.test(line)) {
      if (channel !== undefined) return
      // Other TOML spellings remain the native toolchain manager's concern.
      const match = /^channel\s*=\s*(["'])([A-Za-z0-9][A-Za-z0-9._-]{0,127})\1\s*(?:#.*)?$/.exec(line)
      if (!match) return
      channel = match[2]
    }
  }
  return channel
}

async function projectChannel(root: string): Promise<string | undefined> {
  // Rustup gives the extensionless file precedence when both files exist.
  for (const name of ["rust-toolchain", "rust-toolchain.toml"]) {
    try {
      const path = join(root, name)
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.size > 16_384) return
      return toolchainChannel(await readFile(path, "utf8"), name === "rust-toolchain")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return
    }
  }
  return
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Reuse an installed project pin without invoking rustup, mise or an installer. */
export async function cargoVerificationEnvironment(
  root: string,
  source: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...source, RUSTUP_AUTO_INSTALL: "0" }
  // An explicit native override takes precedence over project toolchain files.
  if (source.RUSTUP_TOOLCHAIN !== undefined) return env
  const channel = await projectChannel(root)
  if (!channel) return env
  const rustupHome = source.RUSTUP_HOME ?? join(source.HOME ?? homedir(), ".rustup")
  if (!isAbsolute(rustupHome)) return env
  const directory = join(rustupHome, "toolchains")
  let names: string[]
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name === channel || (name.startsWith(`${channel}-`) && hostTriple.test(name.slice(channel.length + 1))),
      )
  } catch {
    return env
  }
  const suffix = process.platform === "win32" ? ".exe" : ""
  const installed = await Promise.all(
    names.map(async (name) => {
      const bin = join(directory, name, "bin")
      return (await executable(join(bin, `cargo${suffix}`))) && (await executable(join(bin, `rustc${suffix}`)))
        ? { name, bin }
        : undefined
    }),
  )
  const available = installed.filter((entry) => entry !== undefined)
  const selected =
    available.find((entry) => entry.name === channel) ?? (available.length === 1 ? available[0] : undefined)
  if (!selected) return env
  return {
    ...env,
    PATH: source.PATH ? `${selected.bin}${delimiter}${source.PATH}` : selected.bin,
    RUSTUP_TOOLCHAIN: selected.name,
  }
}
