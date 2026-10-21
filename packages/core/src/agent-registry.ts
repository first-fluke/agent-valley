/**
 * Agent vendor registry — the single table for per-agent facts.
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
  /** Env vars forwarded to the agent subprocess for authentication. */
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
      "BAILIAN_CODING_PLAN_API_KEY",
      "BAILIAN_TOKEN_PLAN_API_KEY",
    ],
    capabilities: ["abort"],
    genAiSystem: "qwen-code",
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
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "XDG_DATA_HOME"],
    capabilities: ["append_prompt", "abort"],
    genAiSystem: "opencode",
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
