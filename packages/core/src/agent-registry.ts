/**
 * Agent vendor registry ??the single table for per-agent facts.
 *
 * Consumers derive from this module instead of keeping parallel lists:
 * SessionFactory registration, config enum, intervention capabilities,
 * environment forwarding, telemetry provider mapping, and CLI binary lookup.
 * Only presentation copy (install/login hints) stays in the CLI.
 */
import { AGENT_IDS, type AgentType } from "./domain/agent"
import type { InterventionCapability } from "./domain/ports/agent-runner"

export interface AgentDescriptor {
  /** Config-facing vendor id (also the literal each session passes to buildAgentEnv). */
  id: AgentType
  /** CLI binary name on PATH. */
  binary: string
  /** Credential and native configuration env vars forwarded to the agent subprocess. */
  envKeys: readonly string[]
  /** Intervention commands the port supports for this agent. */
  capabilities: readonly InterventionCapability[]
  /** OpenTelemetry `gen_ai.system` value. */
  genAiSystem: string
}

export const AGENT_REGISTRY: Record<AgentType, AgentDescriptor> = Object.freeze({
  claude: {
    id: "claude",
    binary: "claude",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "anthropic",
  },
  codex: {
    id: "codex",
    binary: "codex",
    envKeys: ["OPENAI_API_KEY", "CODEX_HOME"],
    capabilities: ["pause", "resume", "append_prompt", "abort"],
    genAiSystem: "openai",
  },
  qwen: {
    id: "qwen",
    binary: "qwen",
    envKeys: [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "QWEN_MODEL",
      "QWEN_HOME",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "GEMINI_API_KEY",
      "GEMINI_MODEL",
      "GOOGLE_API_KEY",
      "GOOGLE_MODEL",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "DASHSCOPE_API_KEY",
      "QWENCLOUD_API_KEY",
      "QWENCLOUD_TOKEN_PLAN_API_KEY",
      "BAILIAN_CODING_PLAN_API_KEY",
      "BAILIAN_TOKEN_PLAN_API_KEY",
    ],
    capabilities: ["abort"],
    genAiSystem: "qwen-code",
  },
  dsh: {
    id: "dsh",
    binary: "dsh",
    envKeys: ["DEEPSEEK_API_KEY", "DSH_HOME"],
    capabilities: ["abort"],
    genAiSystem: "deepseek",
  },
  zcode: {
    id: "zcode",
    binary: "zcode",
    envKeys: [
      "ZCODE_DATA_BASE_DIR",
      "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODE_CREDENTIAL_SECRET",
      "ZCODE_HTTP_PROXY",
      "ZCODE_NO_PROXY",
      "ZCODE_AGENT_CA_CERT",
      "ZCODE_MAX_TOOL_CONCURRENCY",
      "ZCODE_BASE_URL",
      "ZCODE_ENDPOINT_ORIGIN",
    ],
    capabilities: ["abort"],
    genAiSystem: "z.ai",
  },
  antigravity: {
    id: "antigravity",
    binary: "agy",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "gcp.antigravity",
  },
  cursor: {
    id: "cursor",
    binary: "cursor-agent",
    envKeys: ["CURSOR_API_KEY"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "cursor",
  },
  grok: {
    id: "grok",
    binary: "grok",
    envKeys: ["XAI_API_KEY", "GROK_API_KEY"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "xai",
  },
  // kimi primarily authenticates via ~/.kimi-code/config.toml (device-code
  // flow); env keys are forwarded when present.
  kimi: {
    id: "kimi",
    binary: "kimi",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_CODE_HOME"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "moonshotai",
  },
  // opencode is multi-provider; auth.json is primary, env keys are passthroughs.
  opencode: {
    id: "opencode",
    binary: "opencode",
    envKeys: [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_DISABLE_FREE_MODELS",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "opencode",
  },
  // kilo uses the OpenCode CLI protocol + Kilo Gateway free/paid catalog.
  kilo: {
    id: "kilo",
    binary: "kilo",
    envKeys: [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "KILO_API_KEY",
      "KILO_DISABLE_FREE_MODELS",
      "KILO_DISABLE_MODELS_FETCH",
      "KILO_CONFIG",
      "KILO_CONFIG_CONTENT",
      "KILO_CONFIG_DIR",
      "OPENCODE_API_KEY",
      "OPENCODE_DISABLE_FREE_MODELS",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "kilo",
  },
  // freellm uses the FreeLLMAPI router via Codex CLI JSON-RPC app-server.
  freellm: {
    id: "freellm",
    binary: "codex",
    envKeys: ["FREELLM_API_KEY", "FREELLMAPI_API_KEY", "FREELLM_BASE_URL", "FREELLM_MODEL", "CODEX_HOME"],
    capabilities: ["pause", "resume", "append_prompt", "abort"],
    genAiSystem: "freellm",
  },
})

export const AGENT_TYPES = AGENT_IDS

/**
 * Capabilities for a config-supplied agent type. Unknown/custom agents keep the
 * prior permissive default so community sessions still expose a useful UI.
 */
export function capabilitiesFor(agentType: string): InterventionCapability[] {
  const descriptor = AGENT_REGISTRY[agentType as AgentType]
  return [...(descriptor?.capabilities ?? ["append_prompt", "abort"])]
}

export function agentEnvKeys(agentType: string): readonly string[] {
  return AGENT_REGISTRY[agentType as AgentType]?.envKeys ?? []
}

export function agentBinary(agentType: string): string {
  return AGENT_REGISTRY[agentType as AgentType]?.binary ?? agentType
}

export function genAiSystemFor(agentType: string): string {
  return AGENT_REGISTRY[agentType as AgentType]?.genAiSystem ?? agentType
}
