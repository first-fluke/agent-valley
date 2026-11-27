/**
 * sandbox-toolchain-paths.ts — Shared multi-language toolchain cache grants and
 * credential denylist for macOS Seatbelt and Linux bubblewrap sandboxes.
 *
 * Keeps common language toolchains (Rust/Mise, Go, Python pip/uv, JS pnpm/yarn,
 * Dart/Flutter, SwiftPM, JVM Gradle/Maven) writable in their cache directories
 * while explicitly denying read and write access to known package-registry and
 * publishing credential files/directories.
 */

import { isAbsolute } from "node:path"

export interface ToolchainSandboxPaths {
  /** Deduplicated absolute cache directories toolchains may write to. */
  writableDirs: string[]
  /** Deduplicated absolute credential files that must remain unreadable and unwritable. */
  credentialFiles: string[]
  /** Deduplicated absolute credential directories that must remain unreadable and unwritable. */
  credentialDirs: string[]
}

function normalizeAbsoluteEnvDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const stripped = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed
  const normalized = stripped || "/"
  return isAbsolute(normalized) ? normalized : undefined
}

function envDirOrDefault(value: string | undefined, fallback: string): string {
  return normalizeAbsoluteEnvDir(value) ?? fallback
}

export function toolchainSandboxPaths(
  platform: "darwin" | "linux",
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): ToolchainSandboxPaths {
  const isDarwin = platform === "darwin"

  // Rust / Mise
  const cargoHome = envDirOrDefault(env.CARGO_HOME, `${home}/.cargo`)
  const rustupHome = envDirOrDefault(env.RUSTUP_HOME, `${home}/.rustup`)
  const miseStateDir = envDirOrDefault(env.MISE_STATE_DIR, `${home}/.local/state/mise`)
  const miseDataDir = envDirOrDefault(env.MISE_DATA_DIR, `${home}/.local/share/mise`)

  // Go
  const goPath = envDirOrDefault(env.GOPATH, `${home}/go`)
  const goModCache = envDirOrDefault(env.GOMODCACHE, `${goPath}/pkg/mod`)
  const goCache = envDirOrDefault(env.GOCACHE, isDarwin ? `${home}/Library/Caches/go-build` : `${home}/.cache/go-build`)

  // Python (pip / uv)
  const pythonDirs: string[] = isDarwin
    ? [
        envDirOrDefault(env.PIP_CACHE_DIR, `${home}/Library/Caches/pip`),
        envDirOrDefault(env.UV_CACHE_DIR, `${home}/Library/Caches/uv`),
      ]
    : [normalizeAbsoluteEnvDir(env.PIP_CACHE_DIR), normalizeAbsoluteEnvDir(env.UV_CACHE_DIR)].filter(
        (dir): dir is string => dir !== undefined,
      )

  // JS (pnpm / yarn) — supplements ~/.npm and ~/.bun
  const pnpmHome = envDirOrDefault(env.PNPM_HOME, isDarwin ? `${home}/Library/pnpm` : `${home}/.local/share/pnpm`)
  const jsDirs = [
    pnpmHome,
    `${home}/.pnpm-store`,
    `${home}/.yarn`,
    ...(isDarwin ? [`${home}/Library/Caches/Yarn`, `${home}/Library/Caches/pnpm`] : []),
  ]

  // Dart / Flutter
  const pubCache = envDirOrDefault(env.PUB_CACHE, `${home}/.pub-cache`)

  // Swift (SwiftPM, macOS)
  const swiftDirs = isDarwin ? [`${home}/Library/Caches/org.swift.swiftpm`, `${home}/Library/org.swift.swiftpm`] : []

  // JVM (Gradle / Maven)
  const gradleHome = envDirOrDefault(env.GRADLE_USER_HOME, `${home}/.gradle`)
  const mavenHome = `${home}/.m2`

  const writableDirs = [
    ...new Set([
      cargoHome,
      rustupHome,
      miseStateDir,
      miseDataDir,
      goModCache,
      goCache,
      ...pythonDirs,
      ...jsDirs,
      pubCache,
      ...swiftDirs,
      gradleHome,
      mavenHome,
    ]),
  ]

  const credentialFiles = [
    ...new Set([
      `${cargoHome}/credentials`,
      `${cargoHome}/credentials.toml`,
      `${gradleHome}/gradle.properties`,
      `${mavenHome}/settings.xml`,
      `${mavenHome}/settings-security.xml`,
      `${pubCache}/credentials.json`,
      `${home}/.pypirc`,
      `${home}/.netrc`,
      `${home}/.npmrc`,
      `${home}/.yarnrc`,
      `${home}/.yarnrc.yml`,
    ]),
  ]

  const credentialDirs = [...new Set([`${gradleHome}/init.d`])]

  return { writableDirs, credentialFiles, credentialDirs }
}
