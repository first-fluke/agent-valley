import { join } from "node:path"
import { getAgentAuthEnvKeys } from "@agent-valley/core/sessions/base-session"
import { qwenProfilePath } from "@agent-valley/core/sessions/qwen-profile"
import type { AgentAvailability, DiscoveryDeps } from "./agent-discovery"

type Evidence = Pick<AgentAvailability, "readiness" | "reason">
const PROTOCOLS = {
  openai: { key: "OPENAI_API_KEY", models: ["OPENAI_MODEL", "QWEN_MODEL"] },
  anthropic: { key: "ANTHROPIC_API_KEY", models: ["ANTHROPIC_MODEL"] },
  gemini: { key: "GEMINI_API_KEY", models: ["GEMINI_MODEL"] },
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
function problem(detail: string, readiness: Evidence["readiness"] = "unknown"): Evidence {
  return {
    readiness,
    reason: `${detail}. Launch qwen, configure a current provider with /auth, then /exit and retry av order.`,
  }
}

/** Native provider/model selection is required; old cached Qwen OAuth tokens are insufficient.
 * https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
 * Only inspect bounded user settings; workspace overrides and .env files require manual selection.
 */
export function qwenAuth(deps: DiscoveryDeps, read: (path: string) => unknown): Evidence {
  const home = qwenProfilePath(deps.home, deps.env)
  if (!home) return problem("Use an absolute QWEN_HOME so discovery and mission worktrees share the same profile")
  const settings = record(read(join(home, "settings.json")))
  const localEnv = record(settings.env)
  const allowed = new Set(getAgentAuthEnvKeys("qwen"))
  const env = (key: string): unknown => deps.env[key] ?? localEnv[key]
  const selected = record(record(settings.security).auth).selectedType
  if (selected === "qwen-oauth")
    return problem("Cached Qwen OAuth is no longer a supported provider", "unauthenticated")
  const protocol = selected ?? Object.entries(PROTOCOLS).find(([, value]) => text(env(value.key)))?.[0]
  if (typeof protocol !== "string" || !Object.hasOwn(PROTOCOLS, protocol)) {
    return problem("Qwen provider authentication could not be confirmed")
  }
  const defaults = PROTOCOLS[protocol as keyof typeof PROTOCOLS]
  const configuredModel = record(settings.model).name
  const model = text(configuredModel) ? configuredModel : defaults.models.map(env).find(text)
  if (!text(model))
    return problem("Configure a default Qwen model in settings.json or its provider model environment variable")
  const entries = record(settings.modelProviders)[protocol]
  const provider = Array.isArray(entries) ? entries.map(record).find((entry) => entry.id === model) : undefined
  if (Array.isArray(entries) && entries.length > 0 && !provider) {
    return problem("The selected Qwen model has no matching configured provider")
  }
  const key = text(provider?.envKey) ? provider.envKey : defaults.key
  // Native settings.env can supply custom names; shell keys must survive the shared session allowlist.
  const credential = allowed.has(key) ? env(key) : localEnv[key]
  if (!text(credential)) return problem("The selected Qwen provider has no usable API credential", "unauthenticated")
  if (protocol === "anthropic" && !text(provider?.baseUrl) && !text(env("ANTHROPIC_BASE_URL"))) {
    return problem("The selected Qwen Anthropic provider requires ANTHROPIC_BASE_URL or its configured baseUrl")
  }
  if (key !== defaults.key && !text(provider?.baseUrl)) {
    return problem("The selected Qwen custom provider requires its configured baseUrl")
  }
  return { readiness: "ready", reason: "Qwen selected model and provider credentials are configured" }
}
