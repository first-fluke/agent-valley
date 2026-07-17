/**
 * `av up` / `av dev` wiring for automatic Linear webhook registration.
 *
 * Split out from `index.ts` to keep that file under the 500-line limit
 * in docs/architecture/CONSTRAINTS.md. Layer: Presentation (CLI) — no
 * business logic; delegates to `upsertWebhook` in
 * `packages/core/src/tracker/linear-webhook-client.ts`.
 */

import { loadConfig } from "@agent-valley/core/config/yaml-loader"
import pc from "picocolors"

/**
 * Register/update av's own Linear webhook once the tunnel URL is known,
 * so the operator never has to create it by hand in Linear's dashboard.
 *
 * Linear-only: GitHub webhook auto-registration via the REST API is a
 * separate follow-up (GitHub mode is skipped here, not broken).
 *
 * Never throws — a failure here must not crash `av up` / `av dev`. On
 * failure we log an actionable WARN and the operator can still register
 * the webhook manually as a fallback.
 */
export async function registerLinearWebhook(root: string, tunnelUrl: string): Promise<void> {
  let cfg: ReturnType<typeof loadConfig>
  try {
    cfg = loadConfig(root)
  } catch (err) {
    console.log(pc.yellow(`⚠ Skipped Linear webhook registration: config load failed (${(err as Error).message})`))
    return
  }

  if (cfg.trackerKind !== "linear") {
    // GitHub webhook auto-registration is a follow-up — not implemented yet.
    return
  }

  const webhookUrl = `${tunnelUrl}/api/webhook`

  try {
    const { upsertWebhook } = await import("@agent-valley/core/tracker/linear-client")
    const result = await upsertWebhook({
      apiKey: cfg.linearApiKey,
      teamId: cfg.linearTeamUuid,
      url: webhookUrl,
      secret: cfg.linearWebhookSecret,
    })
    console.log(pc.green(`▶ Linear webhook registered → ${result.url}`))
  } catch (err) {
    console.log(pc.yellow(`⚠ Could not auto-register Linear webhook: ${(err as Error).message}`))
    console.log(pc.dim("  Fallback: create the webhook manually in Linear → Settings → API → Webhooks."))
  }
}
