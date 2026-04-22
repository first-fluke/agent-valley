/**
 * Shared types and sentinel values for the setup wizard.
 *
 * The step loop uses BACK / CANCEL symbols as non-value signals so step
 * functions can return a discriminated result without tripping on
 * accidental string equality.
 */

export interface LinearTeam {
  id: string
  key: string
  name: string
}

export interface WorkflowState {
  id: string
  name: string
  type: string
}

export const BACK = Symbol("BACK")
export const CANCEL = Symbol("CANCEL")
export type StepResult = typeof BACK | typeof CANCEL | undefined

export type TrackerKind = "linear" | "github"

export type AgentType = "claude" | "codex" | "gemini"

export interface LinearSetupValues {
  apiKey: string
  teams: LinearTeam[]
  orgUrlKey: string
  teamUuid: string
  selectedTeam: LinearTeam
  states: WorkflowState[]
  todoStateId: string
  inProgressStateId: string
  doneStateId: string
  cancelledStateId: string
  webhookSecret: string
}

export interface GithubSetupValues {
  /**
   * Personal access token — captured in-memory only. Never written to
   * settings.yaml or valley.yaml. The final config references the env var
   * name in `github.token_env`.
   */
  token: string
  /** Env var name the user will set (default: GITHUB_TOKEN). */
  tokenEnv: string
  owner: string
  repo: string
  webhookSecret: string
  labels: {
    todo: string
    inProgress: string
    done: string
    cancelled: string
  }
}

export type TunnelProvider = "cloudflare" | "ngrok" | "none"
export type TunnelMode = "quick" | "named"

export interface TunnelCloudflareValues {
  mode: TunnelMode
  /** Required when mode === "named". */
  name?: string
  /** Optional UI-only hint — used to render the webhook URL. */
  hostname?: string
}

export interface TunnelSetupValues {
  provider: TunnelProvider
  cloudflare?: TunnelCloudflareValues
}

/**
 * Setup context accumulated across steps. Fields are partial while the
 * wizard is running; the orchestrator (index.ts) asserts required fields
 * before rendering preview / saving.
 */
export interface SetupContext {
  trackerKind?: TrackerKind
  linear?: Partial<LinearSetupValues>
  github?: Partial<GithubSetupValues>
  workspaceRoot?: string
  agentType?: AgentType
  maxParallel?: number
  tunnel?: TunnelSetupValues
}

export type StepFn = (ctx: SetupContext, step: number, total: number) => Promise<StepResult>
