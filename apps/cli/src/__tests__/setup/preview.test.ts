/**
 * Preview rendering must:
 *   1. Never print the raw GitHub token value.
 *   2. Never print the webhook secret verbatim (mask to ****xxxx).
 *   3. Always print the token_env name so the operator knows which env
 *      var to export after setup.
 */

import { describe, expect, it } from "vitest"
import { renderPreview } from "../../setup/preview"
import type { ResolvedSetupContext } from "../../setup/resolve"

// Strip ANSI colour codes so assertions are not defeated by picocolors.
// The ESC (0x1B) byte is built from its code point to keep biome's
// "no control characters in regex" rule happy.
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
function strip(s: string): string {
  return s.replace(ANSI_RE, "")
}

const linearCtx: ResolvedSetupContext = {
  trackerKind: "linear",
  linear: {
    apiKey: "lin_api_abcdef1234567890",
    teams: [],
    orgUrlKey: "acme",
    teamUuid: "uuid-team-1",
    selectedTeam: { id: "uuid-team-1", key: "ACR", name: "Acme" },
    states: [],
    todoStateId: "t",
    inProgressStateId: "ip",
    doneStateId: "d",
    cancelledStateId: "c",
    webhookSecret: "lin_wh_supersecret987654",
  },
  github: {
    token: "",
    tokenEnv: "",
    owner: "",
    repo: "",
    webhookSecret: "",
    labels: { todo: "", inProgress: "", done: "", cancelled: "" },
  },
  workspaceRoot: "/home/x/workspaces",
  agentType: "claude",
  maxParallel: 3,
  tunnel: { provider: "ngrok" },
}

const githubCtx: ResolvedSetupContext = {
  trackerKind: "github",
  github: {
    token: "ghp_SECRET_VALUE_DO_NOT_PRINT",
    tokenEnv: "GITHUB_TOKEN",
    owner: "first-fluke",
    repo: "agent-valley",
    webhookSecret: "whsec_abcdefghij0123456789",
    labels: {
      todo: "valley:todo",
      inProgress: "valley:wip",
      done: "valley:done",
      cancelled: "valley:cancelled",
    },
  },
  linear: {
    apiKey: "",
    teams: [],
    orgUrlKey: "",
    teamUuid: "",
    selectedTeam: { id: "", key: "", name: "" },
    states: [],
    todoStateId: "",
    inProgressStateId: "",
    doneStateId: "",
    cancelledStateId: "",
    webhookSecret: "",
  },
  workspaceRoot: "/home/x/workspaces",
  agentType: "codex",
  maxParallel: 2,
  tunnel: { provider: "ngrok" },
}

describe("renderPreview (linear)", () => {
  it("masks API key and webhook secret, never prints them raw", () => {
    const out = strip(renderPreview(linearCtx))
    expect(out).not.toContain("lin_api_abcdef1234567890")
    expect(out).toContain("lin_api_****7890") // from maskApiKey
    expect(out).not.toContain("lin_wh_supersecret987654")
    // mask: keeps first 8 + last 4
    expect(out).toContain("lin_wh_s****7654")
  })

  it("includes tracker.kind = linear", () => {
    expect(strip(renderPreview(linearCtx))).toContain("tracker.kind           = linear")
  })
})

describe("renderPreview — tunnel", () => {
  it("always includes tunnel.provider", () => {
    expect(strip(renderPreview(linearCtx))).toContain("tunnel.provider        = ngrok")
  })

  it("includes cloudflare named mode fields when selected", () => {
    const out = strip(
      renderPreview({
        ...linearCtx,
        tunnel: {
          provider: "cloudflare",
          cloudflare: { mode: "named", name: "av-webhook", hostname: "hooks.example.com" },
        },
      }),
    )
    expect(out).toContain("tunnel.provider        = cloudflare")
    expect(out).toContain("tunnel.cloudflare.mode = named")
    expect(out).toContain("tunnel.cloudflare.name = av-webhook")
    expect(out).toContain("tunnel.cloudflare.host = hooks.example.com")
  })
})

describe("renderPreview (github)", () => {
  const rendered = strip(renderPreview(githubCtx))

  it("NEVER includes the raw GitHub token", () => {
    expect(rendered).not.toContain("ghp_SECRET_VALUE_DO_NOT_PRINT")
    expect(rendered).not.toContain("SECRET_VALUE")
  })

  it("prints the token_env name so the operator can export it", () => {
    expect(rendered).toContain("github.token_env       = GITHUB_TOKEN")
  })

  it("masks the webhook secret", () => {
    expect(rendered).not.toContain("whsec_abcdefghij0123456789")
    expect(rendered).toContain("****6789")
  })

  it("prints owner, repo, and labels", () => {
    expect(rendered).toContain("github.owner           = first-fluke")
    expect(rendered).toContain("github.repo            = agent-valley")
    expect(rendered).toContain("valley:todo")
    expect(rendered).toContain("valley:wip")
    expect(rendered).toContain("valley:done")
    expect(rendered).toContain("valley:cancelled")
  })
})
