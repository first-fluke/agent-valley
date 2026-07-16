/**
 * Relay credentials reader — reads the Supabase access token + user id
 * written by `av login` (apps/cli/src/login.ts) at
 * `~/.agent-valley/credentials.json`.
 *
 * Read-only: this module never writes or mutates the credentials file.
 * Writing / refresh remains CLI-owned (apps/cli/src/login.ts). Kept as a
 * small standalone reader here (rather than importing the CLI app) so
 * apps/dashboard does not gain a cross-app dependency on apps/cli.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { logger } from "../observability/logger"

export interface RelayCredentials {
  accessToken: string
  userId: string
  expiresAt: number
}

/** Matches apps/cli/src/login.ts CREDENTIALS_FILE. */
export function defaultCredentialsPath(): string {
  return join(homedir(), ".agent-valley", "credentials.json")
}

/**
 * Load Supabase access-token credentials for the ledger relay.
 *
 * Returns null (never throws) when the file is missing, unreadable,
 * corrupt, incomplete, or expired. Callers must treat a null return as
 * "team mode is configured but there is no usable Supabase session yet"
 * and skip wiring the relay with a WARN log — never crash orchestrator
 * boot over a missing/expired login.
 */
export function loadRelayCredentials(path: string = defaultCredentialsPath()): RelayCredentials | null {
  try {
    const raw = readFileSync(path, "utf-8")
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw) as Partial<RelayCredentials>
    if (!parsed.accessToken || !parsed.userId) return null
    if (typeof parsed.expiresAt === "number" && parsed.expiresAt > 0 && parsed.expiresAt < Date.now()) {
      logger.warn(
        "relay-credentials",
        "Supabase session expired — run 'av login' again to re-enable the team ledger relay",
        { expiresAt: new Date(parsed.expiresAt).toISOString(), fix: "Run 'av login' from the project root." },
      )
      return null
    }
    return { accessToken: parsed.accessToken, userId: parsed.userId, expiresAt: parsed.expiresAt ?? 0 }
  } catch {
    // Missing file (never logged in) or corrupt JSON — not an error,
    // just "no session available yet".
    return null
  }
}
