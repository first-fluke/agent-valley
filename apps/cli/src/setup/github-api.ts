/**
 * GitHub helpers used by the setup wizard.
 *
 * - `verifyGithubToken` pre-flights the user's PAT against `GET /user` so
 *   the wizard can emit an actionable 5-field error before the user
 *   commits the config file.
 * - `randomWebhookSecret` generates a strong default the user can accept
 *   with a single keypress.
 *
 * These are Presentation-layer helpers (boundary validation). The actual
 * runtime adapter lives in packages/core/src/tracker/adapters/.
 */

import { randomBytes } from "node:crypto"

export interface GithubTokenVerification {
  ok: boolean
  login?: string
  scopes: string[]
  /** Populated when ok === false. Structured 5-field error string. */
  error?: string
}

const REQUIRED_SCOPES = ["repo", "public_repo"]

/**
 * Call `GET https://api.github.com/user` with the provided PAT. Returns
 * `{ ok: true, login, scopes }` on 200, otherwise a structured error.
 *
 * GitHub classic PATs expose granted scopes via the `X-OAuth-Scopes`
 * response header. Fine-grained PATs do not — we accept those when the
 * request succeeds and leave scope-narrowing to the adapter's runtime
 * error messages.
 */
export async function verifyGithubToken(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GithubTokenVerification> {
  if (!token) {
    return {
      ok: false,
      scopes: [],
      error:
        "GitHub token is empty.\n" +
        "  code: setup.github.token_missing\n" +
        "  context: {}\n" +
        "  fix: paste a PAT with 'repo' (or 'public_repo' for public repos only) scope.\n" +
        "  retryable: true",
    }
  }

  let res: Response
  try {
    res = await fetchImpl("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agent-valley-setup",
      },
    })
  } catch (err) {
    return {
      ok: false,
      scopes: [],
      error:
        "GitHub token check failed: network error.\n" +
        "  code: setup.github.network_error\n" +
        `  context: {"cause":${JSON.stringify((err as Error).message ?? String(err))}}\n` +
        "  fix: check your internet connection and retry. If behind a proxy, set HTTPS_PROXY.\n" +
        "  retryable: true",
    }
  }

  if (res.status === 401) {
    return {
      ok: false,
      scopes: [],
      error:
        "GitHub token is invalid (401 Unauthorized).\n" +
        "  code: setup.github.unauthorized\n" +
        '  context: {"status":401}\n' +
        "  fix: regenerate a PAT at https://github.com/settings/tokens with 'repo' scope and paste again.\n" +
        "  retryable: true",
    }
  }

  if (res.status !== 200) {
    return {
      ok: false,
      scopes: [],
      error:
        `GitHub token check returned HTTP ${res.status}.\n` +
        "  code: setup.github.http_error\n" +
        `  context: {"status":${res.status}}\n` +
        "  fix: retry; if 5xx persists check https://www.githubstatus.com. If 403, token may be rate-limited.\n" +
        `  retryable: ${res.status >= 500}`,
    }
  }

  const scopesHeader = res.headers.get("x-oauth-scopes") ?? ""
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // Classic PATs expose scopes. Only enforce the requirement when the
  // header is present — fine-grained PATs return no scopes header.
  if (scopesHeader && !scopes.some((s) => REQUIRED_SCOPES.includes(s))) {
    return {
      ok: false,
      scopes,
      error:
        "GitHub token is missing a required scope.\n" +
        "  code: setup.github.missing_scope\n" +
        `  context: {"scopes":${JSON.stringify(scopes)},"required":${JSON.stringify(REQUIRED_SCOPES)}}\n` +
        "  fix: edit the PAT and enable 'repo' (private repos) or 'public_repo' (public only).\n" +
        "  retryable: true",
    }
  }

  let login: string | undefined
  try {
    const body = (await res.json()) as { login?: string }
    login = typeof body.login === "string" ? body.login : undefined
  } catch {
    // Body parse failure is not fatal for the token check — the 200 is.
  }

  return { ok: true, login, scopes }
}

/**
 * Generate a high-entropy webhook secret (256 bits of hex). Used as the
 * default value when the user accepts the "generate?" prompt.
 */
export function randomWebhookSecret(): string {
  return randomBytes(32).toString("hex")
}

/**
 * Expand a label prefix into the four concrete label names used by the
 * GitHub tracker adapter. Separated for unit-testing.
 */
export function buildGithubLabels(prefix: string): {
  todo: string
  inProgress: string
  done: string
  cancelled: string
} {
  const p = prefix.trim() || "valley"
  return {
    todo: `${p}:todo`,
    inProgress: `${p}:wip`,
    done: `${p}:done`,
    cancelled: `${p}:cancelled`,
  }
}
