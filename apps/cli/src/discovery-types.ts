/** Shared discovery contracts (leaf module to avoid agent-discovery ↔ qwen-discovery cycles). */
import type { AgentType } from "./doctor-checks"

export type AgentReadiness = "ready" | "unknown" | "unavailable" | "unauthenticated"

export interface AgentAvailability {
  agentType: AgentType
  binaryPath?: string
  readiness: AgentReadiness
  reason: string
}

export interface AuthProbeResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface AuthProbeOptions {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
}

export interface DiscoveryDeps {
  home: string
  env: NodeJS.ProcessEnv
  now: () => number
  resolveBinary: (name: string) => string | null
  isExecutableFile: (path: string) => boolean
  fileInfo: (path: string) => { isFile: boolean; size: number } | null
  readFile: (path: string) => string
  parseToml: (content: string) => unknown
  probe: (path: string, args: readonly string[], options: AuthProbeOptions) => Promise<AuthProbeResult>
}
