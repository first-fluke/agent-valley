import { spawn } from "node:child_process"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  cwd?: string
  ignoreStdio?: boolean
  env?: Record<string, string | undefined>
}

/** Disable repository-controlled programs before Git operates outside an Actor sandbox. */
export const GIT_SAFETY_ARGS = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.fsmonitor=false",
])

export function runCommand(cmd: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const argv = cmd === "git" ? [...GIT_SAFETY_ARGS, ...args] : args
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, {
      cwd: options.cwd ?? process.cwd(),
      stdio: options.ignoreStdio ? "ignore" : ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    })
    let stdout = ""
    let stderr = ""
    if (!options.ignoreStdio) {
      if (proc.stdout)
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
        })
      if (proc.stderr)
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString()
        })
    }
    proc.once("error", (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` }))
    proc.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}
