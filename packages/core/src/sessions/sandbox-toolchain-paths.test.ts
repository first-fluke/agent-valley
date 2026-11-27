import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"
import { buildLinuxSandboxCommand } from "./sandbox-linux"
import { toolchainSandboxPaths } from "./sandbox-toolchain-paths"

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("toolchainSandboxPaths", () => {
  it("resolves default Darwin toolchain cache dirs and credential denylist", () => {
    const home = "/Users/actor"
    const result = toolchainSandboxPaths("darwin", home, {})

    expect(result.writableDirs).toEqual(
      expect.arrayContaining([
        `${home}/.cargo`,
        `${home}/.rustup`,
        `${home}/.local/state/mise`,
        `${home}/.local/share/mise`,
        `${home}/go/pkg/mod`,
        `${home}/Library/Caches/go-build`,
        `${home}/Library/Caches/pip`,
        `${home}/Library/Caches/uv`,
        `${home}/Library/pnpm`,
        `${home}/.pnpm-store`,
        `${home}/.yarn`,
        `${home}/Library/Caches/Yarn`,
        `${home}/Library/Caches/pnpm`,
        `${home}/.pub-cache`,
        `${home}/Library/Caches/org.swift.swiftpm`,
        `${home}/Library/org.swift.swiftpm`,
        `${home}/.gradle`,
        `${home}/.m2`,
      ]),
    )
    expect(result.credentialFiles).toEqual([
      `${home}/.cargo/credentials`,
      `${home}/.cargo/credentials.toml`,
      `${home}/.gradle/gradle.properties`,
      `${home}/.m2/settings.xml`,
      `${home}/.m2/settings-security.xml`,
      `${home}/.pub-cache/credentials.json`,
      `${home}/.pypirc`,
      `${home}/.netrc`,
      `${home}/.npmrc`,
      `${home}/.yarnrc`,
      `${home}/.yarnrc.yml`,
    ])
    expect(result.credentialDirs).toEqual([`${home}/.gradle/init.d`])
  })

  it("resolves default Linux toolchain cache dirs without macOS Library paths", () => {
    const home = "/home/actor"
    const result = toolchainSandboxPaths("linux", home, {})

    expect(result.writableDirs).toEqual(
      expect.arrayContaining([
        `${home}/.cargo`,
        `${home}/.rustup`,
        `${home}/.local/state/mise`,
        `${home}/.local/share/mise`,
        `${home}/go/pkg/mod`,
        `${home}/.cache/go-build`,
        `${home}/.local/share/pnpm`,
        `${home}/.pnpm-store`,
        `${home}/.yarn`,
        `${home}/.pub-cache`,
        `${home}/.gradle`,
        `${home}/.m2`,
      ]),
    )
    expect(result.writableDirs.some((dir) => dir.includes("/Library/"))).toBe(false)
    expect(result.writableDirs).not.toContain(`${home}/.cache/pip`)
    expect(result.writableDirs).not.toContain(`${home}/.cache/uv`)
  })

  it("honors absolute env overrides, strips trailing slashes, deduplicates, and ignores relative overrides", () => {
    const home = "/home/actor"
    const result = toolchainSandboxPaths("linux", home, {
      CARGO_HOME: "/opt/cargo/",
      RUSTUP_HOME: "relative/rustup",
      GOPATH: "/opt/go/",
      GOMODCACHE: "",
      GOCACHE: "/opt/go-cache/",
      PIP_CACHE_DIR: "/opt/pip-cache/",
      UV_CACHE_DIR: "relative-uv",
      PNPM_HOME: "/opt/pnpm/",
      PUB_CACHE: "/opt/pub/",
      GRADLE_USER_HOME: "/opt/gradle/",
    })

    expect(result.writableDirs).toEqual(
      expect.arrayContaining([
        "/opt/cargo",
        `${home}/.rustup`,
        "/opt/go/pkg/mod",
        "/opt/go-cache",
        "/opt/pip-cache",
        "/opt/pnpm",
        "/opt/pub",
        "/opt/gradle",
      ]),
    )
    expect(result.writableDirs).not.toContain("relative/rustup")
    expect(result.writableDirs).not.toContain("relative-uv")
    expect(result.credentialFiles).toEqual(
      expect.arrayContaining([
        "/opt/cargo/credentials",
        "/opt/cargo/credentials.toml",
        "/opt/gradle/gradle.properties",
        "/opt/pub/credentials.json",
      ]),
    )
    expect(result.credentialDirs).toEqual(["/opt/gradle/init.d"])
  })
})

describe("Darwin Seatbelt multi-language caches and credential protection", () => {
  it("grants writable toolchain caches and denies all toolchain credentials after allow rules", () => {
    const root = makeTempDir("av-darwin-toolchain-")
    const realHome = join(root, "real-home")
    const aliasHome = join(root, "alias-home")
    const workspace = join(root, "workspace")
    mkdirSync(join(realHome, ".gradle"), { recursive: true })
    mkdirSync(workspace)
    symlinkSync(realHome, aliasHome, "dir")

    const profile = buildDarwinSandboxCommand(
      {
        agentType: "claude",
        command: process.execPath,
        args: [],
        workspacePath: workspace,
        networkAllowlist: [],
        env: {},
      },
      "/usr/bin/sandbox-exec",
      aliasHome,
      null,
    ).args[1] as string

    for (const dir of [
      `${aliasHome}/go/pkg/mod`,
      `${aliasHome}/Library/Caches/go-build`,
      `${aliasHome}/Library/Caches/pip`,
      `${aliasHome}/Library/Caches/uv`,
      `${aliasHome}/Library/pnpm`,
      `${aliasHome}/.pnpm-store`,
      `${aliasHome}/.yarn`,
      `${aliasHome}/Library/Caches/Yarn`,
      `${aliasHome}/Library/Caches/pnpm`,
      `${aliasHome}/.pub-cache`,
      `${aliasHome}/Library/Caches/org.swift.swiftpm`,
      `${aliasHome}/Library/org.swift.swiftpm`,
      `${aliasHome}/.gradle`,
      `${aliasHome}/.m2`,
    ]) {
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(dir)}))`)
    }

    // Both alias and canonical parent forms are denied for read and write AFTER allows.
    const allowWriteIdx = profile.indexOf(`(allow file-write* (subpath ${JSON.stringify(`${aliasHome}/.gradle`)}))`)
    for (const credFile of [
      `${aliasHome}/.gradle/gradle.properties`,
      `${realHome}/.gradle/gradle.properties`,
      `${aliasHome}/.m2/settings.xml`,
      `${aliasHome}/.m2/settings-security.xml`,
      `${aliasHome}/.pub-cache/credentials.json`,
      `${aliasHome}/.pypirc`,
      `${aliasHome}/.netrc`,
      `${aliasHome}/.npmrc`,
      `${aliasHome}/.yarnrc`,
      `${aliasHome}/.yarnrc.yml`,
    ]) {
      expect(profile).toContain(`(deny file-read* (literal ${JSON.stringify(credFile)}))`)
      const denyWriteIdx = profile.indexOf(`(deny file-write* (literal ${JSON.stringify(credFile)}))`)
      expect(denyWriteIdx).toBeGreaterThan(allowWriteIdx)
    }

    for (const credDir of [`${aliasHome}/.gradle/init.d`, `${realHome}/.gradle/init.d`]) {
      expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(credDir)}))`)
      const denyWriteIdx = profile.indexOf(`(deny file-write* (subpath ${JSON.stringify(credDir)}))`)
      expect(denyWriteIdx).toBeGreaterThan(allowWriteIdx)
    }
  })

  it.skipIf(process.platform !== "darwin")(
    "enforces real Seatbelt allow/deny boundaries for toolchain caches and credentials",
    () => {
      const root = makeTempDir("av-darwin-toolchain-live-")
      const fakeHome = join(root, "home")
      const workspace = join(root, "workspace")
      const gradleCaches = join(fakeHome, ".gradle", "caches")
      const gradleInitD = join(fakeHome, ".gradle", "init.d")
      const m2 = join(fakeHome, ".m2")
      const pubCache = join(fakeHome, ".pub-cache")
      for (const dir of [workspace, gradleCaches, gradleInitD, m2, pubCache]) {
        mkdirSync(dir, { recursive: true })
      }

      const secretFiles = [
        join(fakeHome, ".gradle", "gradle.properties"),
        join(gradleInitD, "signing.gradle"),
        join(m2, "settings.xml"),
        join(pubCache, "credentials.json"),
        join(fakeHome, ".npmrc"),
        join(fakeHome, ".pypirc"),
        join(fakeHome, ".netrc"),
      ]
      for (const file of secretFiles) writeFileSync(file, "synthetic-secret")

      const cacheFile = join(gradleCaches, "ok.txt")
      const script = `
        const fs = require('node:fs');
        fs.writeFileSync(process.argv[1], 'cache-ok');
        const denied = (fn) => { try { fn(); return false } catch (e) { return ['EPERM','EACCES'].includes(e.code) } };
        for (const secret of process.argv.slice(2)) {
          if (!denied(() => fs.readFileSync(secret))) { console.error('READ_ALLOWED:' + secret); process.exit(2); }
          if (!denied(() => fs.writeFileSync(secret, 'mutated'))) { console.error('WRITE_ALLOWED:' + secret); process.exit(3); }
        }
      `
      const plan = buildDarwinSandboxCommand(
        {
          agentType: "claude",
          command: process.execPath,
          args: ["-e", script, cacheFile, ...secretFiles],
          workspacePath: workspace,
          networkAllowlist: [],
          env: {},
        },
        "/usr/bin/sandbox-exec",
        fakeHome,
      )
      const result = spawnSync(plan.command, plan.args, { cwd: workspace, encoding: "utf8", timeout: 5_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(cacheFile, "utf8")).toBe("cache-ok")
      for (const file of secretFiles) expect(readFileSync(file, "utf8")).toBe("synthetic-secret")
    },
  )
})

describe("Linux bwrap multi-language caches and conditional credential masking", () => {
  function extractFlagTargets(args: string[], flag: "--bind-try" | "--tmpfs"): string[] {
    const out: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === flag && args[i + 1]) out.push(args[i + 1] as string)
    }
    return out
  }

  function extractDevNullMasks(args: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2]) {
        out.push(args[i + 2] as string)
      }
    }
    return out
  }

  it("binds Linux toolchain caches and skips masking optional toolchain dirs that do not exist on host", () => {
    const root = makeTempDir("av-linux-toolchain-missing-")
    const fakeHome = join(root, "home")
    const workspace = join(root, "workspace")
    mkdirSync(fakeHome)
    mkdirSync(workspace)

    const result = buildLinuxSandboxCommand(
      {
        agentType: "claude",
        command: "claude",
        args: ["--print"],
        workspacePath: workspace,
        networkAllowlist: [],
        env: {},
      },
      "bwrap",
      fakeHome,
    )

    const bound = extractFlagTargets(result.args, "--bind-try")
    expect(bound).toEqual(
      expect.arrayContaining([
        `${fakeHome}/.cargo`,
        `${fakeHome}/.rustup`,
        `${fakeHome}/.local/state/mise`,
        `${fakeHome}/.local/share/mise`,
        `${fakeHome}/go/pkg/mod`,
        `${fakeHome}/.cache/go-build`,
        `${fakeHome}/.local/share/pnpm`,
        `${fakeHome}/.pnpm-store`,
        `${fakeHome}/.yarn`,
        `${fakeHome}/.pub-cache`,
        `${fakeHome}/.gradle`,
        `${fakeHome}/.m2`,
      ]),
    )

    const maskedFiles = extractDevNullMasks(result.args)
    const maskedDirs = extractFlagTargets(result.args, "--tmpfs")

    // Direct $HOME credential files are always masked because $HOME is mounted.
    for (const file of [
      `${fakeHome}/.pypirc`,
      `${fakeHome}/.netrc`,
      `${fakeHome}/.npmrc`,
      `${fakeHome}/.yarnrc`,
      `${fakeHome}/.yarnrc.yml`,
    ]) {
      expect(maskedFiles).toContain(file)
    }

    // Optional toolchain subdirs do NOT exist on disk -> must NOT be masked (would break bwrap!).
    for (const absentFile of [
      `${fakeHome}/.cargo/credentials`,
      `${fakeHome}/.cargo/credentials.toml`,
      `${fakeHome}/.gradle/gradle.properties`,
      `${fakeHome}/.m2/settings.xml`,
      `${fakeHome}/.m2/settings-security.xml`,
      `${fakeHome}/.pub-cache/credentials.json`,
    ]) {
      expect(maskedFiles).not.toContain(absentFile)
    }
    expect(maskedDirs).not.toContain(`${fakeHome}/.gradle/init.d`)
  })

  it("masks optional toolchain credentials after --bind-try when their parent dirs exist (including custom env overrides)", () => {
    const root = makeTempDir("av-linux-toolchain-present-")
    const fakeHome = join(root, "home")
    const workspace = join(root, "workspace")
    const customCargo = join(root, "custom-cargo")
    const gradleDir = join(fakeHome, ".gradle")
    const m2Dir = join(fakeHome, ".m2")
    const pubDir = join(fakeHome, ".pub-cache")
    for (const dir of [fakeHome, workspace, customCargo, gradleDir, m2Dir, pubDir]) {
      mkdirSync(dir, { recursive: true })
    }

    const result = buildLinuxSandboxCommand(
      {
        agentType: "claude",
        command: "claude",
        args: ["--print"],
        workspacePath: workspace,
        networkAllowlist: [],
        env: { CARGO_HOME: customCargo },
      },
      "bwrap",
      fakeHome,
    )

    const maskedFiles = extractDevNullMasks(result.args)
    const maskedDirs = extractFlagTargets(result.args, "--tmpfs")
    expect(maskedFiles).toEqual(
      expect.arrayContaining([
        `${customCargo}/credentials`,
        `${customCargo}/credentials.toml`,
        `${gradleDir}/gradle.properties`,
        `${m2Dir}/settings.xml`,
        `${m2Dir}/settings-security.xml`,
        `${pubDir}/credentials.json`,
      ]),
    )
    expect(maskedDirs).toContain(`${gradleDir}/init.d`)

    // Masks must come AFTER the --bind-try for the writable parent dir.
    const cargoBindIdx = result.args.indexOf(customCargo)
    const cargoMaskIdx = result.args.indexOf(`${customCargo}/credentials.toml`)
    expect(cargoBindIdx).toBeGreaterThan(-1)
    expect(cargoMaskIdx).toBeGreaterThan(cargoBindIdx)

    const gradleBindIdx = result.args.indexOf(gradleDir)
    const gradleInitMaskIdx = result.args.indexOf(`${gradleDir}/init.d`)
    expect(gradleBindIdx).toBeGreaterThan(-1)
    expect(gradleInitMaskIdx).toBeGreaterThan(gradleBindIdx)
  })
})
