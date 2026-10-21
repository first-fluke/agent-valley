/** User team tokens are verified by the gateway; database credentials stay on the server. */
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { normalizeTeamRelayUrl } from "@agent-valley/core/config/team-schema"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import {
  defaultCredentialsPath,
  loadRelayCredentials,
  type RelayCredentials,
  type RelayCredentialsBinding,
  validateRelayCredentials,
} from "@agent-valley/core/relay/credentials"
import { TeamRelayClient } from "@agent-valley/core/relay/team-relay-client"
import * as p from "@clack/prompts"
import pc from "picocolors"

export type Credentials = RelayCredentials

export function saveCredentials(creds: Credentials, path: string = defaultCredentialsPath()): void {
  const valid = validateRelayCredentials(creds)
  if (!valid) throw new Error("Invalid or expired team session. Run 'av login' again.")
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(valid, null, 2), { flag: "wx", mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Preserve the write/rename failure if best-effort temporary cleanup also fails.
    }
    throw error
  }
}

export function loadCredentials(
  path: string = defaultCredentialsPath(),
  binding?: RelayCredentialsBinding,
): Credentials | null {
  return loadRelayCredentials(path, binding)
}

export function clearCredentials(path: string = defaultCredentialsPath()): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function loadLoginTeamConfig(): RelayCredentialsBinding {
  const global = loadGlobalConfig()
  const project = loadProjectConfig()
  const relayUrl = project?.team?.relay_url ?? global?.team?.relay_url
  const teamId = project?.team?.id ?? global?.team?.id
  if (!relayUrl || !teamId)
    throw new Error(
      "Set team.relay_url and team.id in av.yaml or ~/.config/agent-valley/settings.yaml, then run 'av login'. " +
        "Ask your team administrator for the gateway URL and a user team token.",
    )
  return { relayUrl: normalizeTeamRelayUrl(relayUrl), teamId }
}

export interface LoginDependencies {
  loadTeamConfig?: () => RelayCredentialsBinding
  createClient?: (input: { relayUrl: string; token: string; teamId: string }) => Pick<TeamRelayClient, "getSession">
  credentialsPath?: string
}

export async function login(deps: LoginDependencies = {}): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Login ")))
  let token: string | undefined
  let spinner: ReturnType<typeof p.spinner> | undefined
  try {
    const configured = (deps.loadTeamConfig ?? loadLoginTeamConfig)()
    const binding = { ...configured, relayUrl: normalizeTeamRelayUrl(configured.relayUrl) }
    const path = deps.credentialsPath ?? defaultCredentialsPath()
    const existing = loadCredentials(path, binding)
    if (existing) {
      p.log.info(`Already logged in as ${existing.displayName ?? existing.userId}`)
      const relogin = await p.confirm({ message: "Log in again?" })
      if (p.isCancel(relogin) || !relogin) {
        p.outro("Keeping existing login")
        return
      }
    }
    const entered = await p.password({
      message: "AV user team token",
      validate: (value) =>
        !value?.trim() || /\s/.test(value) ? "Enter the user team token from your administrator" : undefined,
    })
    if (p.isCancel(entered)) {
      p.cancel("Cancelled")
      return
    }
    token = entered
    spinner = p.spinner()
    spinner.start("Verifying team session...")
    const client = (deps.createClient ?? ((input) => new TeamRelayClient(input)))({
      relayUrl: binding.relayUrl,
      teamId: binding.teamId,
      token,
    })
    const identity = await client.getSession()
    const credentials = validateRelayCredentials(
      {
        accessToken: token,
        userId: identity.userId,
        teamId: identity.teamId,
        relayUrl: binding.relayUrl,
        expiresAt: identity.expiresAt,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
      },
      binding,
    )
    if (!credentials)
      throw new Error(
        "The gateway returned an expired or mismatched team session. Ask your administrator for a new user team token.",
      )
    saveCredentials(credentials, path)
    spinner.stop("Authentication complete")
    p.log.success(`Logged in as ${credentials.displayName ?? credentials.userId}`)
    p.log.info(`Credentials saved: ${path}`)
    p.outro(pc.green("Login complete!"))
  } catch (error) {
    spinner?.stop("Authentication failed")
    const message =
      error instanceof Error
        ? error.message
        : "Unable to authenticate. Check team.relay_url and team.id, then run 'av login' again."
    p.log.error(token ? message.split(token).join("[redacted]") : message)
    p.outro(pc.red("Login failed. Check the gateway settings and user team token."))
    process.exitCode = 1
  }
}

export async function logout(path: string = defaultCredentialsPath()): Promise<void> {
  clearCredentials(path)
  p.log.success("Logged out locally. Ask your administrator to revoke the token if needed.")
}
