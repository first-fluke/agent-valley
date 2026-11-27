/**
 * claude-login.ts — keeps the Claude subscription login valid for sandboxed sessions on macOS.
 *
 * Claude Code keeps its subscription login in the macOS keychain, and the access token lives eight hours.
 * A session inside the Seatbelt sandbox does not store a refreshed token: on 2026-11-21 an Actor and the
 * Chief both failed with "OAuth token has expired" when the token expired during a mission, and the mission
 * paused until a process outside the sandbox refreshed the login. One minimal unsandboxed `claude` call
 * 240 seconds before the next expiry moved the stored expiry by eight hours.
 *
 * This module makes that call for the session. It reads only the expiry time of the stored login and never
 * logs or returns the stored value. Linux and Windows keep the login in the profile directory, which the
 * session may write, so the caller uses this for Seatbelt sessions only.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { logger } from "../observability/logger"

/** The CLI refreshes a token that is about to expire; ask this long before the stored expiry. */
export const REFRESH_LEAD_MS = 240_000
const READ_TIMEOUT_MS = 10_000
const REFRESH_TIMEOUT_MS = 120_000
const RECHECK_MS = 60_000
const MAX_TIMER_MS = 2_147_483_647
const MAX_FAILED_REFRESHES = 3
/** A session that carries one of these does not use the stored subscription login. */
const OTHER_CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]

export interface ClaudeLoginDeps {
  now: () => number
  /** Runs a host command outside the sandbox; resolves with stdout, or null when it fails or times out. */
  run: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string },
  ) => Promise<string | null>
}

const hostDeps: ClaudeLoginDeps = {
  now: Date.now,
  run: (command, args, options) =>
    new Promise((resolve) => {
      const child = execFile(
        command,
        args,
        { env: options.env, cwd: options.cwd, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
        (error, stdout) => resolve(error ? null : stdout),
      )
      child.stdin?.end()
    }),
}

/** Keychain service of the login. Claude Code adds a hash of a non-default profile directory. */
export function claudeKeychainService(env: NodeJS.ProcessEnv): string {
  const profile = env.CLAUDE_CONFIG_DIR
  if (!profile) return "Claude Code-credentials"
  return `Claude Code-credentials-${createHash("sha256").update(profile).digest("hex").slice(0, 8)}`
}

/** Expiry (epoch ms) of the stored access token, or null when no subscription login can be read. */
export async function claudeLoginExpiry(
  env: NodeJS.ProcessEnv,
  deps: ClaudeLoginDeps = hostDeps,
): Promise<number | null> {
  const stored = await deps.run(
    "/usr/bin/security",
    ["find-generic-password", "-s", claudeKeychainService(env), "-w"],
    { env, timeoutMs: READ_TIMEOUT_MS },
  )
  if (stored === null) return null
  try {
    const expiresAt: unknown = JSON.parse(stored)?.claudeAiOauth?.expiresAt
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null
  } catch {
    return null
  }
}

/** One refresh per login at a time, however many sessions of this process reach the expiry together. */
const refreshing = new Map<string, Promise<boolean>>()

/** Runs one minimal unsandboxed call so the CLI refreshes and stores the token. True when the expiry moved. */
export function refreshClaudeLogin(env: NodeJS.ProcessEnv, deps: ClaudeLoginDeps = hostDeps): Promise<boolean> {
  const service = claudeKeychainService(env)
  const running = refreshing.get(service)
  if (running) return running
  const attempt = (async () => {
    const before = await claudeLoginExpiry(env, deps)
    if (before === null) return false
    // Another process already refreshed the login.
    if (before - deps.now() > REFRESH_LEAD_MS) return true
    await deps.run(
      "claude",
      [
        "--print",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings",
        '{"disableAllHooks":true}',
        "--model",
        "haiku",
        "Reply with the single word OK",
      ],
      { env, timeoutMs: REFRESH_TIMEOUT_MS, cwd: tmpdir() },
    )
    const after = await claudeLoginExpiry(env, deps)
    const refreshed = after !== null && after > before
    if (refreshed) {
      logger.info("claude-login", "Refreshed the Claude login outside the sandbox before its access token expired", {
        expiresAt: new Date(after).toISOString(),
      })
    } else {
      logger.warn(
        "claude-login",
        "The Claude access token is about to expire and an unsandboxed claude call did not refresh it. " +
          "Sandboxed Claude sessions will fail with an expired token. Run `claude` once in a terminal, or `claude /login` if it asks.",
      )
    }
    return refreshed
  })().finally(() => refreshing.delete(service))
  refreshing.set(service, attempt)
  return attempt
}

export interface ClaudeLoginKeeper {
  /** Resolves once the login is known to outlast the lead time, or nothing can be done about it. */
  ready: Promise<void>
  stop: () => void
}

/**
 * Keeps the stored login ahead of its expiry while one sandboxed session runs: refreshes at once when the
 * token expires within the lead time, otherwise at the lead time before the expiry.
 */
export function keepClaudeLoginFresh(env: NodeJS.ProcessEnv, deps: ClaudeLoginDeps = hostDeps): ClaudeLoginKeeper {
  if (OTHER_CREDENTIALS.some((key) => Boolean(env[key]))) return { ready: Promise.resolve(), stop: () => {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let failures = 0
  const arm = (delayMs: number) => {
    timer = setTimeout(() => void pass().catch(() => {}), Math.min(delayMs, MAX_TIMER_MS))
    timer.unref?.()
  }
  // Said once per session, so a log shows whether this session's login is being kept and until when.
  let announced = false
  const announce = (message: string, fields: Record<string, string>) => {
    if (!announced) logger.info("claude-login", message, fields)
    announced = true
  }
  const pass = async (): Promise<void> => {
    if (stopped) return
    const expiry = await claudeLoginExpiry(env, deps)
    if (stopped) return
    if (expiry === null)
      return announce("No stored Claude login expiry could be read; the host does not refresh this session's login", {
        keychainService: claudeKeychainService(env),
      })
    const wait = expiry - REFRESH_LEAD_MS - deps.now()
    if (wait > 0) {
      announce("Keeping the Claude login of this sandboxed session ahead of its expiry", {
        expiresAt: new Date(expiry).toISOString(),
        refreshAt: new Date(expiry - REFRESH_LEAD_MS).toISOString(),
      })
      return arm(wait)
    }
    if (!(await refreshClaudeLogin(env, deps))) failures += 1
    // The next pass reads the new expiry; a failed refresh is tried again, three times at most.
    if (!stopped && failures < MAX_FAILED_REFRESHES) arm(RECHECK_MS)
  }
  return {
    ready: pass().catch(() => {}),
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
