import { isAbsolute, join } from "node:path"
import { parseEnv } from "node:util"
import { nativeProfilePath } from "@agent-valley/core/sessions/native-profile"
import type { AgentAvailability, DiscoveryDeps } from "./discovery-types"

type Evidence = Pick<AgentAvailability, "readiness" | "reason">
type ReadState = (path: string, parse?: (content: string) => unknown) => unknown
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** The shipped headless profile ignores the Web UI credential store and account login.
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md
 * Only the stable home .env is considered here: an invoking repository .env need not exist in a worktree.
 */
export function dshAuth(deps: DiscoveryDeps, read: ReadState): Evidence {
  const home = nativeProfilePath(deps.home, deps.env, "DSH_HOME", ".dsh")
  if (!home) return { readiness: "unknown", reason: "Use an absolute DSH_HOME profile directory, then retry av order." }
  if (text(deps.env.DEEPSEEK_API_KEY))
    return {
      readiness: "ready",
      reason: "DeepSeek Harness headless API credential is configured in the launch environment",
    }
  const env = deps.env.DEEPSEEK_API_KEY === undefined ? record(read(join(home, ".env"), parseEnv)) : {}
  if (text(env.DEEPSEEK_API_KEY))
    return { readiness: "ready", reason: "DeepSeek Harness headless API credential is configured in its home .env" }
  return {
    readiness: "unauthenticated",
    reason:
      "Export DEEPSEEK_API_KEY or configure it in $DSH_HOME/.env (default ~/.dsh/.env), then retry av order. The default headless profile ignores Web UI saved credentials; customized provider routes need their native configuration.",
  }
}

/** Current standalone CLI personal-provider format; directory presence and doctor --json are not auth.
 * https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/03-config.md
 */
export function zcodeAuth(deps: DiscoveryDeps, read: ReadState): Evidence {
  const home = nativeProfilePath(deps.home, deps.env, "ZCODE_DATA_BASE_DIR", ".zcode", ".zcode")
  const problem = (detail: string): Evidence => ({
    readiness: "unknown",
    reason: `${detail}. Run zcode login or configure the selected provider/model in <data-base>/.zcode/v2/provider_config.json, then retry av order.`,
  })
  if (!home) return problem("Set ZCODE_DATA_BASE_DIR to an absolute parent directory")
  // The CLI fills its bundled built-in path when only a personal override is supplied.
  // Relative files vary per worktree, so readiness requires stable absolute overrides.
  const personal = deps.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
  const builtin = deps.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim()
  if ((personal && !isAbsolute(personal)) || (builtin && !isAbsolute(builtin)))
    return problem("Use absolute ZCODE_PERSONAL_PROVIDER_CONFIG_FILE and ZCODE_BUILTIN_PROVIDER_CONFIG_FILE paths")
  if (builtin && read(builtin) === null) return problem("The ZCODE_BUILTIN_PROVIDER_CONFIG_FILE override is missing")
  const document = record(read(personal ?? join(home, "v2/provider_config.json")))
  if (document.schemaVersion !== 1) return problem("ZCode personal provider configuration could not be confirmed")
  const config = record(document.config)
  const selection = record(config.defaultModelSelection)
  if (!text(selection.providerId) || !text(selection.modelId))
    return problem("ZCode needs a default provider and model")
  const rules = record(config.providerConfigRules).providerRules
  const provider = Array.isArray(rules)
    ? rules.map(record).find((rule) => rule.providerId === selection.providerId)
    : undefined
  const providerConfig = record(provider?.config)
  const access = record(providerConfig.access)
  if (access.type !== "api-key")
    return problem("ZCode selected account-provider credentials require native login verification")
  if (!text(access.apiKey))
    return { ...problem("ZCode selected API provider has no API key"), readiness: "unauthenticated" }
  const api = record(providerConfig.api)
  if (!["openai-chat-completions", "openai-responses", "anthropic-messages"].includes(String(api.type)))
    return problem("ZCode selected provider has an unsupported API protocol")
  if (!text(api.baseUrl) || !/^https?:\/\//.test(api.baseUrl))
    return problem("ZCode selected API provider needs its api.baseUrl")
  const models = providerConfig.personalModelIds
  if (Array.isArray(models) && !models.includes(selection.modelId))
    return problem("ZCode default model does not match the selected provider's models")
  return { readiness: "ready", reason: "ZCode selected model and native API-provider credentials are configured" }
}
