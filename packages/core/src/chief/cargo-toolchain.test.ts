import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as cargoToolchain from "./cargo-toolchain"
import { executeVerificationCommand } from "./verification-command"

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}))

const directories: string[] = []

async function fixture(): Promise<{ root: string; rustupHome: string; env: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(join(tmpdir(), "av-cargo-toolchain-"))
  directories.push(directory)
  const root = join(directory, "project")
  const rustupHome = join(directory, "rustup")
  await mkdir(root)
  return {
    root,
    rustupHome,
    env: {
      PATH: [join(directory, "shims"), join(directory, "system")].join(delimiter),
      RUSTUP_HOME: rustupHome,
      RUSTUP_AUTO_INSTALL: "1",
      KEEP_ME: "retained",
    },
  }
}

async function installedToolchain(rustupHome: string, name: string): Promise<string> {
  const bin = join(rustupHome, "toolchains", name, "bin")
  await mkdir(bin, { recursive: true })
  for (const program of ["cargo", "rustc"]) {
    const path = join(bin, process.platform === "win32" ? `${program}.exe` : program)
    await writeFile(path, "toolchain fixture; never execute\n")
    await chmod(path, 0o755)
  }
  return bin
}

function expectUnselected(actual: NodeJS.ProcessEnv, original: NodeJS.ProcessEnv): void {
  expect(actual).toEqual({ ...original, RUSTUP_AUTO_INSTALL: "0" })
  expect(actual).not.toBe(original)
}

function mockSuccessfulSpawn(): void {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    })
    queueMicrotask(() => child.emit("close", 0))
    return child as unknown as ChildProcess
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Cargo verification toolchain environment", () => {
  it("selects an installed host toolchain from the project TOML without mutating its input", async () => {
    const { root, rustupHome, env } = await fixture()
    const name = "stable-aarch64-apple-darwin"
    const bin = await installedToolchain(rustupHome, name)
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\nprofile = "minimal"\n')
    const original = { ...env }
    Object.freeze(env)

    const actual = await cargoToolchain.cargoVerificationEnvironment(root, env)

    expect(actual).toEqual({
      ...original,
      PATH: `${bin}${delimiter}${original.PATH}`,
      RUSTUP_TOOLCHAIN: name,
      RUSTUP_AUTO_INSTALL: "0",
    })
    expect(env).toEqual(original)
    expect(actual).not.toBe(env)
  })

  it("accepts an exact installed channel name", async () => {
    const { root, rustupHome, env } = await fixture()
    const bin = await installedToolchain(rustupHome, "1.85.1")
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.85.1"\n')

    expect(await cargoToolchain.cargoVerificationEnvironment(root, env)).toMatchObject({
      PATH: `${bin}${delimiter}${env.PATH}`,
      RUSTUP_TOOLCHAIN: "1.85.1",
      RUSTUP_AUTO_INSTALL: "0",
    })
  })

  it.each([
    { filename: "rust-toolchain", contents: "beta\n" },
    { filename: "rust-toolchain", contents: '[toolchain]\nchannel = "beta"\n' },
  ])("gives $filename priority over rust-toolchain.toml for $contents", async ({ filename, contents }) => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    const name = "beta-aarch64-apple-darwin"
    const bin = await installedToolchain(rustupHome, name)
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
    await writeFile(join(root, filename), contents)

    expect(await cargoToolchain.cargoVerificationEnvironment(root, env)).toMatchObject({
      PATH: `${bin}${delimiter}${env.PATH}`,
      RUSTUP_TOOLCHAIN: name,
    })
  })

  it("preserves the existing PATH when the project has no pin", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("preserves an explicit RUSTUP_TOOLCHAIN override and the existing PATH", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
    env.RUSTUP_TOOLCHAIN = "nightly-custom"

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("preserves PATH when the pinned toolchain is not cached", async () => {
    const { root, env } = await fixture()
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it.each(["cargo", "rustc"])("requires an executable %s in the cached bin directory", async (program) => {
    const { root, rustupHome, env } = await fixture()
    const bin = await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    const path = join(bin, process.platform === "win32" ? `${program}.exe` : program)
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
    if (process.platform === "win32") await rm(path)
    else await chmod(path, 0o644)

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("preserves PATH when multiple cached host toolchains match the pin", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    await installedToolchain(rustupHome, "stable-x86_64-unknown-linux-gnu")
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("does not select a dated nightly for a bare nightly pin", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "nightly-2026-11-01-aarch64-apple-darwin")
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "nightly"\n')

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it.each([
    "stable\n",
    '[toolchain]\npath = "../local-toolchain"\n',
    '[toolchain]\nchannel = "stable"\npath = "../local-toolchain"\n',
    '[toolchain]\nchannel = "../local-toolchain"\n',
    '[toolchain]\nchannel = "stable"\nchannel = "beta"\n',
    "[toolchain]\nchannel = stable\n",
    '[other]\nchannel = "stable"\n',
  ])("delegates unsupported project toolchain contents without selecting a path: %s", async (contents) => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    await writeFile(join(root, "rust-toolchain.toml"), contents)

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("does not fall back to TOML when the higher-priority legacy pin is unsupported", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    await writeFile(join(root, "rust-toolchain"), "../local-toolchain\n")
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })

  it("leaves oversized project toolchain files to native resolution", async () => {
    const { root, rustupHome, env } = await fixture()
    await installedToolchain(rustupHome, "stable-aarch64-apple-darwin")
    await writeFile(join(root, "rust-toolchain.toml"), `[toolchain]\nchannel = "stable"\n#${"x".repeat(16_384)}\n`)

    expectUnselected(await cargoToolchain.cargoVerificationEnvironment(root, env), env)
  })
})

describe("Cargo verification spawn boundary", () => {
  it.each([
    { command: "fmt", args: ["fmt", "--all", "--", "--check"] },
    { command: "test", args: ["test", "--workspace"] },
  ])("keeps the approved cargo $command argv and applies the offline cached environment", async ({ args }) => {
    const { root, rustupHome, env } = await fixture()
    const name = "stable-aarch64-apple-darwin"
    const bin = await installedToolchain(rustupHome, name)
    await writeFile(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
    vi.stubEnv("PATH", env.PATH)
    vi.stubEnv("RUSTUP_HOME", rustupHome)
    vi.stubEnv("RUSTUP_TOOLCHAIN", undefined)
    vi.stubEnv("RUSTUP_AUTO_INSTALL", "1")
    vi.stubEnv("GIT_DIR", "/unrelated/git-dir")
    mockSuccessfulSpawn()

    await expect(
      executeVerificationCommand("cargo", args, { cwd: root, timeoutMs: 1_000, maxOutputBytes: 1_024 }),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" })

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "cargo",
      args,
      expect.objectContaining({
        cwd: root,
        shell: false,
        env: expect.objectContaining({
          PATH: `${bin}${delimiter}${env.PATH}`,
          RUSTUP_HOME: rustupHome,
          RUSTUP_TOOLCHAIN: name,
          RUSTUP_AUTO_INSTALL: "0",
          CARGO_NET_OFFLINE: "true",
          CARGO_TERM_COLOR: "never",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_LITERAL_PATHSPECS: "1",
        }),
      }),
    )
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).not.toHaveProperty("GIT_DIR")
    expect(args).toEqual(args[0] === "fmt" ? ["fmt", "--all", "--", "--check"] : ["test", "--workspace"])
  })

  it("does not spawn when cancellation arrives while the toolchain environment is resolving", async () => {
    const { root } = await fixture()
    const controller = new AbortController()
    let complete: (env: NodeJS.ProcessEnv) => void = () => {}
    const resolving = new Promise<NodeJS.ProcessEnv>((resolve) => {
      complete = resolve
    })
    const resolver = vi.spyOn(cargoToolchain, "cargoVerificationEnvironment").mockReturnValueOnce(resolving)
    const pending = executeVerificationCommand("cargo", ["test", "--workspace"], {
      cwd: root,
      signal: controller.signal,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    })
    expect(resolver).toHaveBeenCalledOnce()

    controller.abort()
    complete({ ...process.env, RUSTUP_AUTO_INSTALL: "0" })

    await expect(pending).rejects.toThrow("interrupted")
    expect(spawn).not.toHaveBeenCalled()
  })

  it("does not spawn when toolchain resolution exhausts the command timeout", async () => {
    const { root } = await fixture()
    let elapsed = 0
    vi.spyOn(performance, "now").mockImplementation(() => elapsed)
    let complete: (env: NodeJS.ProcessEnv) => void = () => {}
    const resolving = new Promise<NodeJS.ProcessEnv>((resolve) => {
      complete = resolve
    })
    const resolver = vi.spyOn(cargoToolchain, "cargoVerificationEnvironment").mockReturnValueOnce(resolving)
    const pending = executeVerificationCommand("cargo", ["test", "--workspace"], {
      cwd: root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    })
    expect(resolver).toHaveBeenCalledOnce()

    elapsed = 1_000
    complete({ ...process.env, RUSTUP_AUTO_INSTALL: "0" })

    await expect(pending).rejects.toThrow("timed out")
    expect(spawn).not.toHaveBeenCalled()
  })
})
