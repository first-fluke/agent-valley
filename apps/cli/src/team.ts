import { createHash, randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { normalizeTeamRelayUrl } from "@agent-valley/core/config/team-schema"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { defaultCredentialsPath } from "@agent-valley/core/relay/credentials"
import { importSupabaseTeamSnapshot } from "@agent-valley/core/relay/turso-import"
import { TursoTeamStore } from "@agent-valley/core/relay/turso-team-store"
import type { Command } from "commander"
import { z } from "zod"
import { saveCredentials } from "./login"

interface TeamCommandDependencies {
  projectRoot?: string
  credentialsPath?: string
}

function adminConnection(projectRoot: string) {
  const project = loadProjectConfig(projectRoot)?.team
  const global = loadGlobalConfig()?.team
  const teamId = project?.id ?? global?.id
  const url = project?.turso_url ?? global?.turso_url
  const relayUrl = project?.relay_url ?? global?.relay_url
  if (!teamId || !url || !relayUrl)
    throw new Error(
      "Set team.id, team.turso_url and team.relay_url in av.yaml or settings.yaml on the central server before running av team commands.",
    )
  const tokenEnv = project?.turso_auth_token_env ?? global?.turso_auth_token_env ?? "TURSO_AUTH_TOKEN"
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Set team.turso_url in av.yaml or settings.yaml to a valid file:, libsql:// or HTTPS database URL.")
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["file:", "libsql:", "https:"].includes(parsed.protocol)
  )
    throw new Error(
      "Set team.turso_url to a file:, libsql:// or HTTPS database URL without embedded credentials or query parameters in av.yaml/settings.yaml.",
    )
  const authToken = process.env[tokenEnv]
  if (parsed.protocol !== "file:" && !authToken)
    throw new Error(
      `Set the server environment variable named by team.turso_auth_token_env (${tokenEnv}) before using the remote Turso database. Keep its value out of av.yaml and member machines.`,
    )
  return { teamId, relayUrl: normalizeTeamRelayUrl(relayUrl), url, authToken }
}

function expiration(days: string): number {
  const parsed = z.coerce.number().int().min(1).max(365).safeParse(days)
  if (!parsed.success) throw new Error("Set --days to an integer from 1 through 365.")
  return Date.now() + parsed.data * 86_400_000
}

async function removeUndeliveredToken(store: TursoTeamStore, token: string): Promise<void> {
  await store.client.execute({
    sql: "delete from team_tokens where token_hash=?",
    args: [createHash("sha256").update(token).digest("hex")],
  })
}

/** Administration uses the DB capability on the central machine; workers receive only AV team tokens. */
export function registerTeamCommands(program: Command, deps: TeamCommandDependencies = {}): void {
  const projectRoot = deps.projectRoot ?? process.cwd()
  const team = program.command("team").description("Manage the Turso team ledger on its central server")
  team
    .command("migrate")
    .description("Apply pending Drizzle migrations to the configured Turso database")
    .action(async () => {
      const config = adminConnection(projectRoot)
      const store = new TursoTeamStore(config)
      try {
        await store.initialize()
        console.log("Pending Turso schema migrations applied.")
      } finally {
        store.close()
      }
    })
  team
    .command("init")
    .description("Initialize the schema and save a new owner's AV login locally")
    .requiredOption("--name <name>", "Team name")
    .requiredOption("--slug <slug>", "Unique team slug")
    .option("--user-id <uuid>", "Owner UUID; retain an imported user's ID")
    .option("--display-name <name>", "Owner display name", "Owner")
    .option("--days <days>", "Owner token validity in days", "30")
    .action(async (options: { name: string; slug: string; userId?: string; displayName: string; days: string }) => {
      const expiresAt = expiration(options.days)
      const config = adminConnection(projectRoot)
      const store = new TursoTeamStore(config)
      try {
        await store.initialize()
        await store.ensureTeam({ id: config.teamId, name: options.name, slug: options.slug })
        const { token, identity } = await store.issueToken({
          teamId: config.teamId,
          userId: options.userId ?? randomUUID(),
          displayName: options.displayName,
          role: "owner",
          expiresAt,
        })
        try {
          saveCredentials(
            {
              accessToken: token,
              userId: identity.userId,
              teamId: identity.teamId,
              relayUrl: config.relayUrl,
              expiresAt: identity.expiresAt,
              displayName: identity.displayName,
            },
            deps.credentialsPath ?? defaultCredentialsPath(),
          )
        } catch (error) {
          // Do not leave a newly issued, undelivered credential active.
          await removeUndeliveredToken(store, token)
          throw error
        }
        console.log(
          `Team initialized: ${config.teamId}. Owner login saved locally (${identity.userId}); no database token was shared.`,
        )
      } finally {
        store.close()
      }
    })

  team
    .command("add-member")
    .description("Grant membership and write an AV token to a new private file")
    .requiredOption("--name <name>", "Member display name")
    .requiredOption("--token-file <path>", "New private output file; existing files are never overwritten")
    .option("--user-id <uuid>", "Member UUID; retain an imported user's ID")
    .option("--role <role>", "owner, admin or member", "member")
    .option("--days <days>", "Token validity in days", "30")
    .action(async (options: { name: string; tokenFile: string; userId?: string; role: string; days: string }) => {
      const role = z.enum(["owner", "admin", "member"]).parse(options.role)
      const expiresAt = expiration(options.days)
      const output = resolve(projectRoot, options.tokenFile)
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
      // Reserve a private file before creating the credential, so a collision cannot orphan a token.
      const descriptor = openSync(output, "wx", 0o600)
      let delivered = false
      let issuedToken: string | undefined
      let store: TursoTeamStore | undefined
      try {
        const config = adminConnection(projectRoot)
        store = new TursoTeamStore(config)
        const issued = await store.issueToken({
          teamId: config.teamId,
          userId: options.userId ?? randomUUID(),
          displayName: options.name,
          role,
          expiresAt,
        })
        issuedToken = issued.token
        writeFileSync(descriptor, `${issued.token}\n`)
        fsyncSync(descriptor)
        delivered = true
        console.log(`Member ${issued.identity.userId} added. Transfer the private AV token file securely: ${output}`)
      } finally {
        try {
          closeSync(descriptor)
        } finally {
          try {
            if (!delivered) {
              try {
                unlinkSync(output)
              } finally {
                if (issuedToken && store) await removeUndeliveredToken(store, issuedToken)
              }
            }
          } finally {
            store?.close()
          }
        }
      }
    })

  team
    .command("revoke")
    .description("Revoke a member's AV tokens while preserving their event history")
    .requiredOption("--user-id <uuid>", "Member UUID")
    .action(async (options: { userId: string }) => {
      const config = adminConnection(projectRoot)
      const store = new TursoTeamStore(config)
      try {
        await store.revokeTokens(config.teamId, options.userId)
        console.log(`Revoked team tokens for ${options.userId}. Historical events were retained.`)
      } finally {
        store.close()
      }
    })

  team
    .command("import-supabase")
    .description("Import a bounded read-only JSON export into an empty or matching Turso schema")
    .requiredOption("--file <path>", "JSON produced by turso/import/export-supabase.sql")
    .action(async (options: { file: string }) => {
      const { statSync } = await import("node:fs")
      const inputPath = resolve(projectRoot, options.file)
      if (!statSync(inputPath).isFile() || statSync(inputPath).size > 32_000_000)
        throw new Error("Use a regular JSON export file smaller than 32 MB with at most 20,000 ledger events.")
      const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"))
      const config = adminConnection(projectRoot)
      const store = new TursoTeamStore(config)
      try {
        await store.initialize()
        const result = await importSupabaseTeamSnapshot(store, input)
        console.log(JSON.stringify(result))
        console.log(
          "Import verified. Issue new AV tokens with --user-id to retain imported identities; Supabase authentication secrets were not imported.",
        )
      } finally {
        store.close()
      }
    })
}
