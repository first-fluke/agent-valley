import { execFile } from "node:child_process"

export interface ContainerObservationCommand {
  binary: "docker" | "kubectl"
  args: string[]
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}
export interface ContainerCommandOutput {
  stdout: string
  stderr: string
}
export type ContainerCommandExecutor = (command: ContainerObservationCommand) => Promise<ContainerCommandOutput>

/** Every failure deliberately omits the CLI's stderr, argv, environment and response. */
export class ContainerCommandError extends Error {
  constructor(public readonly failure: "missing-cli" | "timeout" | "cancelled" | "output-limit" | "failed") {
    super(
      {
        "missing-cli": "Container CLI is unavailable. Install the configured Docker or Kubernetes CLI and check PATH.",
        timeout:
          "Container observation timed out. Check CLI connectivity or increase chief.container_observation.timeout_ms in av.yaml.",
        cancelled: "Container observation was cancelled. Resume the operation to collect fresh evidence.",
        "output-limit":
          "Container observation exceeded its output limit. Reduce log_tail or increase chief.container_observation.max_output_bytes in av.yaml.",
        failed:
          "Container observation command failed. Check the configured context, target, daemon and read-only credentials.",
      }[failure],
    )
  }
}

/** Uses argv without a shell and kills the process if stdout + stderr exceed one shared byte limit. */
export const executeContainerCommand: ContainerCommandExecutor = (command) =>
  new Promise((resolve, reject) => {
    if (command.signal?.aborted) return reject(new ContainerCommandError("cancelled"))
    let bytes = 0
    let exceeded = false
    const child = execFile(
      command.binary,
      command.args,
      {
        encoding: "buffer",
        timeout: command.timeoutMs,
        maxBuffer: command.maxOutputBytes,
        killSignal: "SIGKILL",
        signal: command.signal,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (exceeded) return reject(new ContainerCommandError("output-limit"))
        if (command.signal?.aborted) return reject(new ContainerCommandError("cancelled"))
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          return reject(
            new ContainerCommandError(code === "ENOENT" ? "missing-cli" : error.killed ? "timeout" : "failed"),
          )
        }
        resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") })
      },
    )
    const count = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > command.maxOutputBytes) {
        exceeded = true
        child.kill("SIGKILL")
      }
    }
    child.stdout?.on("data", count)
    child.stderr?.on("data", count)
    child.stdin?.end()
  })
