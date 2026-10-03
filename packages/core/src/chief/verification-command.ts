import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { safeVerificationCommand, verificationCommandTestPaths } from "./verification-contract"
import { readVerificationFile } from "./verification-files"

export const MAX_VERIFICATION_OUTPUT_BYTES = 1_048_576

export interface VerificationCommandOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  onSpawned?: (pid: number, detached: boolean) => void
}

export interface VerificationCommandOutput {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type VerificationCommandExecutor = (
  program: string,
  args: string[],
  options: VerificationCommandOptions,
) => Promise<VerificationCommandOutput>

async function joinVerificationGroup(pid: number | undefined, detached: boolean): Promise<void> {
  if (!pid || !detached) return
  let remaining = false
  for (let attempt = 0; attempt < 21; attempt++) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      if (remaining)
        throw new Error("Verification test left child processes running. Await their shutdown in test cleanup.")
      return
    }
    remaining = true
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    if (attempt < 20) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error("Verification child cleanup is incomplete. Stop the retained process group before resuming.")
}

export async function verificationCommandInputs(
  root: string,
  program: string,
  args: string[],
  budget: { remaining: number },
): Promise<{ path: string; sha256: string }[]> {
  if (!safeVerificationCommand(program, args))
    throw new Error("Verification command is outside the allowed argv contract.")
  const names = verificationCommandTestPaths(program, args)
  if (program === "node" && args[0] === "node_modules/vitest/vitest.mjs") {
    // Package managers may link this installed dependency within node_modules.
    const launcher = await realpath(join(root, args[0]))
    if (!launcher.startsWith(`${join(root, "node_modules")}${sep}`))
      throw new Error("Installed Vitest launcher escapes this worktree. Install its dependency inside node_modules.")
    names.unshift(relative(root, launcher))
  }
  const inputs: { path: string; sha256: string }[] = []
  for (const path of names) {
    const file = await readVerificationFile(root, path, budget)
    inputs.push({ path, sha256: file.sha256 })
  }
  return inputs
}

/** Fixed argv only; completion waits for the bounded process to exit. */
export const executeVerificationCommand: VerificationCommandExecutor = (program, args, options) =>
  new Promise((resolveCommand, rejectCommand) => {
    if (!safeVerificationCommand(program, args)) {
      rejectCommand(new Error("Unsupported automatic verification command. Use explicit tests or read-only Git argv."))
      return
    }
    if (options.signal?.aborted) {
      rejectCommand(new Error("Verification interrupted. Resume the mission to rerun its evidence checks."))
      return
    }
    const detached = process.platform !== "win32"
    const env = { ...process.env }
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      delete env[key]
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1" })
    const argv =
      program === "git"
        ? ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat", "--no-pager", ...args]
        : args
    const child = spawn(program, argv, {
      cwd: options.cwd,
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
    let stdout = ""
    let stderr = ""
    let bytes = 0
    let failure: Error | undefined
    const stop = (error: Error): void => {
      failure ??= error
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
          return
        } catch {
          // A process can exit before its timeout or abort is observed.
        }
      }
      child.kill("SIGKILL")
    }
    const abort = (): void => stop(new Error("Verification interrupted. Resume the mission to rerun evidence checks."))
    const timer = setTimeout(
      () => stop(new Error("Verification timed out. Repair the test or increase its bounded timeout.")),
      options.timeoutMs,
    )
    timer.unref()
    const capture = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      bytes += chunk.length
      if (bytes > options.maxOutputBytes) {
        stop(new Error("Verification output exceeds its evidence budget. Reduce noisy test output and retry."))
        return
      }
      if (stream === "stdout") stdout += chunk.toString("utf8")
      else stderr += chunk.toString("utf8")
    }
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"))
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"))
    child.once("error", (error) => {
      failure = error
    })
    child.once("close", async (exitCode) => {
      clearTimeout(timer)
      try {
        await joinVerificationGroup(child.pid, detached)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error("Cannot join verification child processes.")
      }
      options.signal?.removeEventListener("abort", abort)
      if (failure) rejectCommand(failure)
      else resolveCommand({ exitCode, stdout, stderr })
    })
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    if (child.pid && options.onSpawned) {
      try {
        options.onSpawned(child.pid, detached)
      } catch (error) {
        stop(error instanceof Error ? error : new Error("Cannot register automatic verification process."))
      }
    }
  })
