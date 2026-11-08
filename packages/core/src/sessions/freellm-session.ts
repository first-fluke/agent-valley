/**
 * FreellmSession — FreeLLMAPI router session using Codex CLI JSON-RPC app-server.
 *
 * Configures the FreeLLMAPI provider (`model_provider="av_freellm"`) with
 * `FREELLM_BASE_URL` (default: `http://127.0.0.1:31415/v1`), `FREELLM_API_KEY`
 * (or `FREELLMAPI_API_KEY`), and `FREELLM_MODEL` (default: `"auto"`).
 */

import type { AgentConfig } from "./agent-session"
import { CodexSession } from "./codex-session"

export interface FreellmProviderSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export function resolveFreellmSettings(
  config?: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): FreellmProviderSettings {
  const rawBase = env.FREELLM_BASE_URL ?? "http://127.0.0.1:31415/v1"
  let url: URL
  try {
    url = new URL(rawBase)
  } catch {
    throw new Error("FreeLLMAPI base_url must be an absolute HTTP(S) URL.")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("FreeLLMAPI base_url must be HTTP(S), without credentials, query parameters or fragments.")
  }
  const base = url.href.replace(/\/+$/, "")
  const baseUrl = base.endsWith("/v1") ? base : `${base}/v1`

  const key = env.FREELLM_API_KEY?.trim() || env.FREELLMAPI_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "FreeLLMAPI requires FREELLM_API_KEY (or FREELLMAPI_API_KEY). Set the environment variable before starting the agent.",
    )
  }
  if (/[\r\n\0]/.test(key)) {
    throw new Error("FreeLLMAPI API key contains invalid characters.")
  }

  const model = config?.model?.trim() || env.FREELLM_MODEL?.trim() || "auto"
  if (/[\r\n\0]/.test(model)) {
    throw new Error("FreeLLMAPI model must be a non-empty model ID without control characters.")
  }

  return { baseUrl, apiKey: key, model }
}

export class FreellmSession extends CodexSession {
  protected override get vendorAgentType(): string {
    return "freellm"
  }

  protected override buildAppServerArgs(config: AgentConfig): string[] {
    const freellm = resolveFreellmSettings(config, { ...process.env, ...this.config?.env })
    const args = ["app-server", "--listen", "stdio://"]
    args.push("-c", `model=${JSON.stringify(freellm.model)}`)
    args.push("-c", 'model_provider="av_freellm"')
    args.push(
      "-c",
      `model_providers.av_freellm={name="FreeLLMAPI",base_url=${JSON.stringify(freellm.baseUrl)},env_key="AV_FREELLM_API_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
    )
    return args
  }

  protected override buildAppServerEnv(config: AgentConfig): Record<string, string> {
    const freellm = resolveFreellmSettings(config, { ...process.env, ...this.config?.env })
    return {
      AV_FREELLM_API_KEY: freellm.apiKey,
      OMA_FREELLM_API_KEY: freellm.apiKey,
      FREELLM_API_KEY: freellm.apiKey,
      FREELLM_BASE_URL: freellm.baseUrl,
      FREELLM_MODEL: freellm.model,
    }
  }

  override async start(config: AgentConfig): Promise<void> {
    try {
      resolveFreellmSettings(config, { ...process.env, ...config.env })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitError("AUTH_FAILED", message, false)
      throw error
    }
    await super.start(config)
  }
}
