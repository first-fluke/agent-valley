import { z } from "zod"

/** A team token may only be sent to HTTPS, or to a loopback HTTP gateway. */
export function normalizeTeamRelayUrl(value: string): string {
  const input = value.trim()
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("Set team.relay_url to an absolute HTTPS URL (HTTP is allowed only on loopback).")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    [...input].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    input.includes("?") ||
    input.includes("#")
  ) {
    throw new Error("Set team.relay_url to HTTPS or loopback HTTP, without credentials, a query or a fragment.")
  }
  return url.href.replace(/\/+$/, "")
}

export const teamRelayUrlSchema = z.string().transform((value, context) => {
  try {
    return normalizeTeamRelayUrl(value)
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message })
    return z.NEVER
  }
})

const legacyTeamMigration =
  "is no longer supported. Remove this key from av.yaml or ~/.config/agent-valley/settings.yaml; " +
  "set team.relay_url and team.id for clients, and team.turso_url plus team.turso_auth_token_env on the central server. " +
  "Keep the Turso database token on the server and run 'av login' with a user team token."

export const teamConfigSchema = z
  .object({
    relay_url: teamRelayUrlSchema.optional(),
    turso_url: z.string().trim().min(1).optional(),
    turso_auth_token_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    id: z
      .uuid({
        error:
          "Set team.id in av.yaml or ~/.config/agent-valley/settings.yaml to the team UUID supplied by your administrator.",
      })
      .optional(),
    display_name: z.string().min(1).optional(),
    // Recognize retired keys only to produce an actionable error without printing their values.
    supabase_url: z.unknown().optional(),
    supabase_anon_key: z.unknown().optional(),
  })
  .strict()
  .superRefine((team, context) => {
    for (const key of ["supabase_url", "supabase_anon_key"] as const) {
      if (Object.hasOwn(team, key))
        context.addIssue({ code: "custom", path: [key], message: `team.${key} ${legacyTeamMigration}` })
    }
  })
  .transform(({ supabase_url: _url, supabase_anon_key: _key, ...team }) => team)

/** Setup must not silently repair retired authentication keys into a local-mode configuration. */
export class TeamConfigMigrationError extends Error {
  constructor(keys: string[], path: string) {
    super(
      `Team config migration required (${path}):\n${keys.map((key) => `  - team.${key} ${legacyTeamMigration}`).join("\n")}`,
    )
    this.name = "TeamConfigMigrationError"
  }
}

export function assertTeamConfigMigrated(raw: Record<string, unknown>, path: string): void {
  const team = raw.team
  if (typeof team !== "object" || team === null) return
  const keys = ["supabase_url", "supabase_anon_key"].filter((key) => Object.hasOwn(team, key))
  if (keys.length) throw new TeamConfigMigrationError(keys, path)
}
