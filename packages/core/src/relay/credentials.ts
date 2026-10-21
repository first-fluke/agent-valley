/** Read-only, endpoint-bound user credentials written by `av login`. */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { normalizeTeamRelayUrl, teamRelayUrlSchema } from "../config/team-schema"
import { logger } from "../observability/logger"

const credentialsSchema = z
  .object({
    accessToken: z.string().min(1).max(4_096).regex(/^\S+$/),
    userId: z.uuid(),
    teamId: z.uuid(),
    relayUrl: teamRelayUrlSchema,
    expiresAt: z.number().int().positive(),
    displayName: z.string().min(1).max(256).optional(),
  })
  .strict()

export type RelayCredentials = z.infer<typeof credentialsSchema>
export interface RelayCredentialsBinding {
  relayUrl: string
  teamId: string
}

export function defaultCredentialsPath(): string {
  return join(homedir(), ".agent-valley", "credentials.json")
}

/** Validate injected and disk-loaded credentials through the same fail-closed boundary. */
export function validateRelayCredentials(
  value: unknown,
  binding?: RelayCredentialsBinding,
  now: number = Date.now(),
): RelayCredentials | null {
  const result = credentialsSchema.safeParse(value)
  if (!result.success || result.data.expiresAt <= now) return null
  const credentials = result.data
  if (binding) {
    try {
      if (credentials.relayUrl !== normalizeTeamRelayUrl(binding.relayUrl) || credentials.teamId !== binding.teamId)
        return null
    } catch {
      return null
    }
  }
  return credentials
}

/** Missing, expired, legacy or mismatched credentials never enable the relay. */
export function loadRelayCredentials(
  path: string = defaultCredentialsPath(),
  binding?: RelayCredentialsBinding,
  now: number = Date.now(),
): RelayCredentials | null {
  let parsed: unknown
  try {
    const raw = readFileSync(path, "utf-8")
    if (!raw.trim()) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const credentials = validateRelayCredentials(parsed, binding, now)
  if (!credentials)
    logger.warn("relay-credentials", "No valid team session for this gateway and team — run 'av login' again", {
      fix: "Run 'av login' from the project root. Legacy Supabase credentials cannot be reused.",
    })
  return credentials
}
