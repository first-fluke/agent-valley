/**
 * Verification Gate — runs the project's own test/lint/typecheck command
 * (`verify_command`) inside the agent's worktree before delivery. This is
 * the external check that replaces agent self-assessment: an agent that
 * writes broken/non-compiling code and exits 0 must not be marked Done or
 * merged to main on its own say-so.
 *
 * No-op (skipped) when no `verify_command` is configured for the issue's
 * route — preserves pre-gate behavior for projects that have not opted in.
 *
 * Wired into `completion-handler.ts` § onComplete, before delivery and
 * before the Done transition.
 */

import { spawn } from "node:child_process"
import type { ResolvedRoute } from "../config/routing"
import type { Config } from "../config/yaml-loader"
import type { Workspace } from "../domain/models"
import { logger } from "../observability/logger"

/** Bound captured verify output to the last 10KB — same tail-truncation pattern as sessions/claude-session.ts. */
const MAX_OUTPUT_LENGTH = 10_240
const DEFAULT_TIMEOUT_SEC = 600

export interface VerifyExecResult {
  exitCode: number
  output: string
  timedOut: boolean
}

/** Injectable command runner so `runVerificationGate` is testable without spawning real processes. */
export type VerifyExecFn = (command: string, cwd: string, timeoutMs: number) => Promise<VerifyExecResult>

/** Real implementation: runs `command` through the shell in `cwd`, killing it if it exceeds `timeoutMs`. */
export const defaultVerifyExec: VerifyExecFn = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const proc = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })

    let output = ""
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, timeoutMs)

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.once("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      output += `\n${String(err)}`
      resolve({ exitCode: -1, output, timedOut })
    })

    proc.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? -1 : (code ?? -1), output, timedOut })
    })
  })

function boundOutput(output: string): string {
  return output.length > MAX_OUTPUT_LENGTH ? output.slice(-MAX_OUTPUT_LENGTH) : output
}

export interface VerificationGateResult {
  /** false when no verify_command was configured — the gate did not run (no-op). */
  ran: boolean
  /** true when the gate did not run, or ran and exited 0 within the timeout. */
  ok: boolean
  command?: string
  /** Captured stdout+stderr, bounded to the last 10KB. */
  output?: string
  timedOut?: boolean
}

export interface VerificationGateOptions {
  timeoutSec?: number
  exec?: VerifyExecFn
}

/**
 * Resolve the effective verify_command for an issue's route: a per-route
 * override (`routing.rules[].verify_command`) wins over the project-wide
 * `verify.command`. Returns undefined when neither is set (gate is a no-op).
 */
export function resolveVerifyCommand(config: Config, route: ResolvedRoute): string | undefined {
  if (route.matchedLabel) {
    const rule = config.routingRules.find((r) => r.label === route.matchedLabel)
    if (rule?.verifyCommand) return rule.verifyCommand
  }
  return config.verify?.command
}

/**
 * Run `command` inside `workspace.path`. Returns `ran: false, ok: true`
 * (no-op) when `command` is undefined, so callers can gate on `result.ok`
 * without a separate presence check.
 */
export async function runVerificationGate(
  workspace: Workspace,
  command: string | undefined,
  opts: VerificationGateOptions = {},
): Promise<VerificationGateResult> {
  if (!command) {
    logger.debug("verification-gate", "No verify_command configured — verification gate skipped", {
      workspacePath: workspace.path,
    })
    return { ran: false, ok: true }
  }

  const exec = opts.exec ?? defaultVerifyExec
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const timeoutMs = timeoutSec * 1000

  logger.info("verification-gate", "Running verify_command", { workspacePath: workspace.path, command, timeoutSec })

  const result = await exec(command, workspace.path, timeoutMs)
  const output = boundOutput(result.output)
  const ok = !result.timedOut && result.exitCode === 0

  if (ok) {
    logger.info("verification-gate", "verify_command passed", { workspacePath: workspace.path, command })
  } else {
    logger.warn("verification-gate", "verify_command failed", {
      workspacePath: workspace.path,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    })
  }

  return { ran: true, ok, command, output, timedOut: result.timedOut }
}

/** Build the retry-prompt fed back to the agent via the existing retry queue when the gate fails. */
export function buildVerificationFailurePrompt(result: VerificationGateResult): string {
  const header = result.timedOut
    ? `Verification command timed out: ${result.command}`
    : `Verification command failed: ${result.command}`

  return [
    header,
    "Retry instruction:",
    "- Fix the failing tests/lint/typecheck errors shown in the output below.",
    "- Re-run the verify command yourself before finishing to confirm it passes.",
    "",
    "### Verification output (tail)",
    "```",
    result.output && result.output.length > 0 ? result.output : "(no output captured)",
    "```",
  ].join("\n")
}
