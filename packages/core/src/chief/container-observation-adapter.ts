import {
  ContainerCommandError,
  type ContainerCommandExecutor,
  type ContainerCommandOutput,
} from "./container-observation-command"
import type {
  ContainerObservationPolicy,
  ContainerObservationResult,
  ContainerObservationTarget,
} from "./container-observation-policy"
import { containerDigest, containerErrorEvidence, sanitizeContainerText } from "./container-observation-text"

export type CollectedContainerResult = Omit<ContainerObservationResult, "fingerprint">
export interface ContainerAdapterContext {
  policy: ContainerObservationPolicy
  target: ContainerObservationTarget
  previous?: ContainerObservationResult
  env: Readonly<Record<string, string | undefined>>
  now: () => Date
  run: (args: string[]) => Promise<ContainerCommandOutput>
}

export function createContainerCommandRunner(
  target: ContainerObservationTarget,
  policy: ContainerObservationPolicy,
  execute: ContainerCommandExecutor,
  signal?: AbortSignal,
): ContainerAdapterContext["run"] {
  let remaining = policy.max_output_bytes
  const deadline = Date.now() + policy.timeout_ms
  return async (args) => {
    if (signal?.aborted) throw new ContainerCommandError("cancelled")
    if (remaining <= 0) throw new ContainerCommandError("output-limit")
    const timeout = deadline - Date.now()
    if (timeout <= 0) throw new ContainerCommandError("timeout")
    const output = await execute({
      binary: target.kind === "docker" ? "docker" : "kubectl",
      args,
      timeoutMs: timeout,
      maxOutputBytes: remaining,
      signal,
    })
    if (typeof output?.stdout !== "string" || typeof output?.stderr !== "string")
      throw new ContainerCommandError("failed")
    remaining -= Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)
    if (remaining < 0) throw new ContainerCommandError("output-limit")
    return output
  }
}

export function containerObservationFailure(error: unknown): string {
  return error instanceof ContainerCommandError
    ? error.message
    : "Container evidence is invalid or unavailable. Check the configured target, context, CLI version and read-only credentials."
}

export function addContainerReason(result: CollectedContainerResult, reason: string): void {
  result.reason = [result.reason, reason].filter(Boolean).join(" ").slice(0, 1_000)
}

export function setContainerLogs(result: CollectedContainerResult, value: string, ctx: ContainerAdapterContext): void {
  const text = sanitizeContainerText(value, ctx.env)
  result.logsAvailable = true
  // Keep recent failure evidence even when successful high-volume logs precede it.
  const evidence = containerErrorEvidence(text)
  result.logExcerpt = (evidence.length ? evidence.join("\n") : text).slice(-8_192)
  if (evidence.length) result.issues.push("log-error")
}

export function addContainerResourceIssues(result: CollectedContainerResult, policy: ContainerObservationPolicy): void {
  if (
    policy.cpu_percent_threshold !== undefined &&
    result.cpuPercent !== undefined &&
    result.cpuPercent >= policy.cpu_percent_threshold
  )
    result.issues.push("cpu-high")
  if (
    policy.memory_percent_threshold !== undefined &&
    result.memoryPercent !== undefined &&
    result.memoryPercent >= policy.memory_percent_threshold
  )
    result.issues.push("memory-high")
}

export function containerStatsRequested(policy: ContainerObservationPolicy): boolean {
  return policy.cpu_percent_threshold !== undefined || policy.memory_percent_threshold !== undefined
}

export function containerResultFingerprint(result: CollectedContainerResult): string {
  const { logExcerpt, cpuPercent: _cpu, memoryPercent: _memory, reason: _reason, ...stable } = result
  // Percent fluctuations within the same threshold band and successful logs do not repeatedly wake Chief.
  return containerDigest({
    ...stable,
    logEvidence: result.issues.includes("log-error") ? containerErrorEvidence(logExcerpt ?? "") : [],
  })
}

export function hasFreshContainerRestart(
  result: CollectedContainerResult,
  previous?: ContainerObservationResult,
): boolean {
  return Boolean(
    previous?.status === "collected" &&
      previous.identity === result.identity &&
      result.restartCount !== undefined &&
      previous.restartCount !== undefined &&
      result.restartCount > previous.restartCount,
  )
}
