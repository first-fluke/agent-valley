import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from "jose"
import { z } from "zod"

export interface AvMcpOAuthOptions {
  publicUrl: string
  issuer: string
  audience: string
  scopes: string[]
  allowedSubjects: string[]
}

export interface McpOAuthInput {
  publicUrl?: string
  oauthIssuer?: string
  oauthAudience?: string
  oauthScope?: string[]
  oauthSubject?: string[]
}

export type McpOAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type McpOAuthAuthorization =
  | { authorized: true; subject: string }
  | { authorized: false; status: 401 | 403; error: "invalid_token" | "insufficient_scope" | "access_denied" }

export interface AvMcpOAuth {
  publicUrl: string
  resourceMetadataUrl: string
  resourceMetadata: {
    resource: string
    authorization_servers: string[]
    scopes_supported: string[]
    bearer_methods_supported: string[]
  }
  authorize: (authorization: string | undefined) => Promise<McpOAuthAuthorization>
  challenge: (error?: "invalid_token" | "insufficient_scope") => string
}

const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/
const oauthSchema = z.object({
  publicUrl: z.string().min(1),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  scopes: z.array(z.string().min(1).max(256).regex(scopeToken)).min(1),
  allowedSubjects: z
    .array(
      z
        .string()
        .min(1)
        .max(1_024)
        .refine(
          (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
          "User subjects cannot contain control characters.",
        ),
    )
    .min(1),
})
const authorizationServerSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
})

function httpsUrl(value: string, key: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`MCP OAuth ${key} must be an absolute HTTPS URL. Configure the corresponding --oauth option.`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`MCP OAuth ${key} must use HTTPS without credentials, a query or a fragment.`)
  return url
}

function validateOptions(input: AvMcpOAuthOptions): AvMcpOAuthOptions {
  const parsed = oauthSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `Invalid MCP OAuth ${issue?.path.join(".") || "configuration"}: ${issue?.message}. Set --public-url, --oauth-issuer, --oauth-scope and --oauth-subject or their AGENT_VALLEY_MCP_* environment variables.`,
    )
  }
  const options = parsed.data
  const publicUrl = httpsUrl(options.publicUrl, "publicUrl")
  if (publicUrl.pathname !== "/mcp")
    throw new Error("Set --public-url or AGENT_VALLEY_MCP_PUBLIC_URL to the public HTTPS /mcp endpoint.")
  const canonicalResource = publicUrl.href
  if (options.audience !== canonicalResource)
    throw new Error(
      "Set --oauth-audience or AGENT_VALLEY_MCP_OAUTH_AUDIENCE to the exact canonical --public-url. Configure the IdP to bind the OAuth resource parameter to this access-token audience.",
    )
  httpsUrl(options.issuer, "issuer")
  if (options.scopes.includes("offline_access"))
    throw new Error("Use --oauth-scope for AV resource permissions; offline_access is an IdP refresh-token scope.")
  return {
    ...options,
    publicUrl: canonicalResource,
    scopes: [...new Set(options.scopes)],
    allowedSubjects: [...new Set(options.allowedSubjects)],
  }
}

/** No OAuth settings keeps local bearer mode; partial public configuration fails closed. */
export function resolveMcpOAuthOptions(
  input: McpOAuthInput,
  env: NodeJS.ProcessEnv = process.env,
): AvMcpOAuthOptions | undefined {
  const publicUrl = input.publicUrl ?? env.AGENT_VALLEY_MCP_PUBLIC_URL
  const issuer = input.oauthIssuer ?? env.AGENT_VALLEY_MCP_OAUTH_ISSUER
  const audience = input.oauthAudience ?? env.AGENT_VALLEY_MCP_OAUTH_AUDIENCE
  const scopes = input.oauthScope ?? env.AGENT_VALLEY_MCP_OAUTH_SCOPES?.split(/[\s,]+/).filter(Boolean)
  const allowedSubjects =
    input.oauthSubject ??
    env.AGENT_VALLEY_MCP_OAUTH_SUBJECTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  if ([publicUrl, issuer, audience, scopes, allowedSubjects].every((value) => value === undefined)) return undefined
  if (!publicUrl) throw new Error("Set --public-url or AGENT_VALLEY_MCP_PUBLIC_URL before enabling OAuth MCP.")
  if (!issuer) throw new Error("Set --oauth-issuer or AGENT_VALLEY_MCP_OAUTH_ISSUER to your external IdP issuer.")
  if (!scopes?.length)
    throw new Error(
      "Set --oauth-scope or AGENT_VALLEY_MCP_OAUTH_SCOPES to the AV permissions required for tool access.",
    )
  if (!allowedSubjects?.length)
    throw new Error(
      "Set --oauth-subject or AGENT_VALLEY_MCP_OAUTH_SUBJECTS to the exact IdP user subjects allowed to operate this AV workspace.",
    )
  return validateOptions({
    publicUrl,
    issuer,
    audience: audience ?? httpsUrl(publicUrl, "publicUrl").href,
    scopes,
    allowedSubjects,
  })
}

function discoveryUrls(issuer: string): URL[] {
  const url = httpsUrl(issuer, "issuer")
  const path = url.pathname.replace(/\/$/, "")
  return [
    ...new Set([
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      `${url.origin}${path}/.well-known/openid-configuration`,
    ]),
  ].map((value) => new URL(value))
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("OAuth discovery returned an empty document.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65_536) {
        await reader.cancel()
        throw new Error("OAuth discovery document exceeds 64 KiB.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

async function discoverAuthorizationServer(options: AvMcpOAuthOptions, fetcher: McpOAuthFetch) {
  for (const url of discoveryUrls(options.issuer)) {
    let response: Response
    try {
      response = await fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      throw new Error(
        "MCP OAuth issuer discovery failed. Check --oauth-issuer, IdP HTTPS connectivity and discovery metadata.",
      )
    }
    if (response.status === 404) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("MCP OAuth issuer discovery failed. The IdP must serve a public successful discovery document.")
    }
    let document: unknown
    try {
      document = await readJson(response)
    } catch {
      throw new Error(
        "MCP OAuth issuer discovery must return valid JSON within 64 KiB. Fix the IdP discovery document.",
      )
    }
    const parsed = authorizationServerSchema.safeParse(document)
    if (!parsed.success)
      throw new Error(
        "MCP OAuth IdP metadata must provide issuer, authorization_endpoint, token_endpoint, jwks_uri, response_types_supported and code_challenge_methods_supported. Configure discovery and PKCE S256 on the external IdP.",
      )
    const metadata = parsed.data
    if (metadata.issuer !== options.issuer)
      throw new Error(
        "MCP OAuth discovery issuer must exactly match --oauth-issuer. Fix the configured issuer or IdP metadata.",
      )
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) httpsUrl(metadata[key], key)
    if (
      !metadata.response_types_supported.includes("code") ||
      (metadata.grant_types_supported && !metadata.grant_types_supported.includes("authorization_code")) ||
      !metadata.code_challenge_methods_supported.includes("S256")
    )
      throw new Error(
        "MCP OAuth IdP must support authorization-code flow with PKCE S256. Enable these features in the IdP.",
      )
    return metadata
  }
  throw new Error(
    "MCP OAuth issuer has no discovery document. Publish RFC 8414 or OpenID Connect metadata on the external IdP.",
  )
}

/** The external IdP owns user consent, PKCE, OAuth clients and token issuance. AV only verifies resource access. */
export async function createMcpOAuth(options: AvMcpOAuthOptions, fetcher: McpOAuthFetch = fetch): Promise<AvMcpOAuth> {
  const config = validateOptions(options)
  const metadata = await discoverAuthorizationServer(config, fetcher)
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    [customFetch]: (url, init) => fetcher(url, { ...init, redirect: "error" }),
  })
  const subjects = new Set(config.allowedSubjects)
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).href
  const challenge = (error?: "invalid_token" | "insufficient_scope") =>
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="${config.scopes.join(" ")}"${error ? `, error="${error}"` : ""}`
  return {
    publicUrl: config.publicUrl,
    resourceMetadataUrl,
    resourceMetadata: {
      resource: config.publicUrl,
      authorization_servers: [config.issuer],
      scopes_supported: config.scopes,
      bearer_methods_supported: ["header"],
    },
    challenge,
    authorize: async (authorization) => {
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)
      const token = match?.[1]
      if (!token) return { authorized: false, status: 401, error: "invalid_token" }
      let payload: JWTPayload
      try {
        const verified = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"],
          requiredClaims: ["exp", "sub"],
        })
        payload = verified.payload
      } catch {
        return { authorized: false, status: 401, error: "invalid_token" }
      }
      if (typeof payload.sub !== "string" || !subjects.has(payload.sub))
        return { authorized: false, status: 403, error: "access_denied" }
      const scope =
        typeof payload.scope === "string" ? payload.scope : typeof payload.scp === "string" ? payload.scp : ""
      const grantedScopes = new Set(scope.split(" ").filter(Boolean))
      if (config.scopes.some((required) => !grantedScopes.has(required)))
        return { authorized: false, status: 403, error: "insufficient_scope" }
      return { authorized: true, subject: payload.sub }
    },
  }
}
