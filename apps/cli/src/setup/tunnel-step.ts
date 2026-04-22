/**
 * Step: choose the webhook tunnel provider.
 *
 * Writes `tunnel:` into valley.yaml. All three providers are opt-in —
 * the default (ngrok) preserves the v0.2 behaviour for users who skip
 * the prompt.
 */

import * as p from "@clack/prompts"
import { CANCEL, type SetupContext, type StepResult, type TunnelMode, type TunnelProvider } from "./types"
import { stepLabel } from "./ui"

export async function stepTunnel(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const provider = await p.select<TunnelProvider>({
    message: stepLabel(step, total, "Webhook tunnel provider"),
    initialValue: ctx.tunnel?.provider ?? "ngrok",
    options: [
      { value: "ngrok", label: "ngrok", hint: "default — requires `brew install ngrok`" },
      { value: "cloudflare", label: "Cloudflare Tunnel", hint: "requires `cloudflared` on PATH" },
      { value: "none", label: "None", hint: "external reverse proxy or pre-configured tunnel" },
    ],
  })
  if (p.isCancel(provider)) return CANCEL

  ctx.tunnel = { provider }

  if (provider === "cloudflare") {
    const mode = await p.select<TunnelMode>({
      message: stepLabel(step, total, "Cloudflare Tunnel mode"),
      initialValue: ctx.tunnel.cloudflare?.mode ?? "quick",
      options: [
        { value: "quick", label: "Quick", hint: "random trycloudflare.com URL — no account required" },
        { value: "named", label: "Named", hint: "pre-registered tunnel (`cloudflared tunnel create`)" },
      ],
    })
    if (p.isCancel(mode)) return CANCEL

    ctx.tunnel.cloudflare = { mode }

    if (mode === "named") {
      const name = await p.text({
        message: stepLabel(step, total, "Cloudflare tunnel name (from `cloudflared tunnel create <name>`)"),
        initialValue: ctx.tunnel.cloudflare.name ?? "",
        validate: (v) => {
          if (!v || !v.trim()) return "Required for named mode"
        },
      })
      if (p.isCancel(name)) return CANCEL
      ctx.tunnel.cloudflare.name = name.trim()

      const hostname = await p.text({
        message: stepLabel(step, total, "Public hostname (optional — used for webhook URL display)"),
        placeholder: "webhook.example.com",
        initialValue: ctx.tunnel.cloudflare.hostname ?? "",
      })
      if (p.isCancel(hostname)) return CANCEL
      const trimmed = hostname.trim()
      ctx.tunnel.cloudflare.hostname = trimmed.length > 0 ? trimmed : undefined
    }
  }

  return
}
