/**
 * Assert that a partial SetupContext is complete and narrow it to a
 * fully-typed ResolvedSetupContext. Returns an error message instead of
 * throwing so the caller (index.ts) can surface a 5-field error.
 */

import type {
  AgentType,
  GithubSetupValues,
  LinearSetupValues,
  SetupContext,
  TrackerKind,
  TunnelSetupValues,
} from "./types"

export interface ResolvedSetupContext {
  trackerKind: TrackerKind
  /** Present when trackerKind === "linear". */
  linear: LinearSetupValues
  /** Present when trackerKind === "github". */
  github: GithubSetupValues
  workspaceRoot: string
  agentType: AgentType
  maxParallel: number
  tunnel: TunnelSetupValues
}

/**
 * Returns `{ ok: true, ctx }` on success; `{ ok: false, error }` when
 * required fields are missing. The error is an actionable 5-field
 * string so tests and operators can self-correct.
 */
export function resolveContext(
  ctx: SetupContext,
): { ok: true; ctx: ResolvedSetupContext } | { ok: false; error: string } {
  const missing: string[] = []

  if (!ctx.trackerKind) missing.push("trackerKind")
  if (!ctx.workspaceRoot) missing.push("workspaceRoot")
  if (!ctx.agentType) missing.push("agentType")
  if (ctx.maxParallel == null) missing.push("maxParallel")

  if (ctx.trackerKind === "linear") {
    const l = ctx.linear ?? {}
    if (!l.apiKey) missing.push("linear.apiKey")
    if (!l.teamUuid) missing.push("linear.teamUuid")
    if (!l.selectedTeam) missing.push("linear.selectedTeam")
    if (!l.todoStateId) missing.push("linear.todoStateId")
    if (!l.inProgressStateId) missing.push("linear.inProgressStateId")
    if (!l.doneStateId) missing.push("linear.doneStateId")
    if (!l.cancelledStateId) missing.push("linear.cancelledStateId")
    if (!l.webhookSecret) missing.push("linear.webhookSecret")
  } else if (ctx.trackerKind === "github") {
    const g = ctx.github ?? {}
    if (!g.token) missing.push("github.token")
    if (!g.tokenEnv) missing.push("github.tokenEnv")
    if (!g.owner) missing.push("github.owner")
    if (!g.repo) missing.push("github.repo")
    if (!g.webhookSecret) missing.push("github.webhookSecret")
    if (!g.labels?.todo) missing.push("github.labels.todo")
    if (!g.labels?.inProgress) missing.push("github.labels.inProgress")
    if (!g.labels?.done) missing.push("github.labels.done")
    if (!g.labels?.cancelled) missing.push("github.labels.cancelled")
  }

  // Tunnel: defaults to ngrok when the step is skipped (backwards compat).
  const tunnel: TunnelSetupValues = ctx.tunnel ?? { provider: "ngrok" }
  if (tunnel.provider === "cloudflare" && tunnel.cloudflare?.mode === "named" && !tunnel.cloudflare.name) {
    missing.push("tunnel.cloudflare.name")
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        "Setup context is incomplete.\n" +
        "  code: setup.context.incomplete\n" +
        `  context: {"missing":${JSON.stringify(missing)}}\n` +
        "  fix: re-run `bun av setup` and complete every prompt. Do not skip steps.\n" +
        "  retryable: true",
    }
  }

  return {
    ok: true,
    ctx: {
      trackerKind: ctx.trackerKind as TrackerKind,
      linear: (ctx.linear ?? {}) as LinearSetupValues,
      github: (ctx.github ?? {}) as GithubSetupValues,
      workspaceRoot: ctx.workspaceRoot as string,
      agentType: ctx.agentType as AgentType,
      maxParallel: ctx.maxParallel as number,
      tunnel,
    },
  }
}
