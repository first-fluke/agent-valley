/**
 * Linear Webhook Client — create/update av's own webhook registration
 * via the Linear GraphQL API.
 *
 * Split out from `linear-client.ts` to keep that file under the
 * 500-line CONSTRAINTS.md limit (see docs/architecture/CONSTRAINTS.md
 * #5). Reuses `linearGraphQL` from `linear-client.ts` for the same
 * auth/error-handling transport as every other Linear adapter.
 */

import { z } from "zod"
import { logger } from "../observability/logger"
import { linearGraphQL } from "./linear-client"

/**
 * Stable label used to identify av's own webhook across re-runs, so
 * `av up` / `av dev` updates the existing registration instead of
 * creating a duplicate every time the tunnel URL changes.
 */
export const WEBHOOK_LABEL = "agent-valley"

const webhookNodeSchema = z.object({
  id: z.string(),
  url: z.string(),
  label: z.string().nullable().optional(),
  enabled: z.boolean(),
})

const listWebhooksDataSchema = z.object({
  webhooks: z
    .object({
      nodes: z.array(webhookNodeSchema),
    })
    .optional(),
})

const webhookCreateDataSchema = z.object({
  webhookCreate: z
    .object({
      success: z.boolean(),
      webhook: webhookNodeSchema.optional(),
    })
    .optional(),
})

const webhookUpdateDataSchema = z.object({
  webhookUpdate: z
    .object({
      success: z.boolean(),
      webhook: webhookNodeSchema.optional(),
    })
    .optional(),
})

const LIST_WEBHOOKS_QUERY = `
query ListWebhooks($teamId: String!) {
  webhooks(filter: { team: { id: { eq: $teamId } } }) {
    nodes { id url label enabled }
  }
}
`

const CREATE_WEBHOOK_MUTATION = `
mutation CreateWebhook($teamId: String!, $url: String!, $secret: String!, $label: String!) {
  webhookCreate(input: { teamId: $teamId, url: $url, secret: $secret, label: $label, resourceTypes: ["Issue"], enabled: true }) {
    success
    webhook { id url label enabled }
  }
}
`

const UPDATE_WEBHOOK_MUTATION = `
mutation UpdateWebhook($id: String!, $url: String!, $enabled: Boolean!) {
  webhookUpdate(id: $id, input: { url: $url, enabled: $enabled }) {
    success
    webhook { id url label enabled }
  }
}
`

/** True when a Linear error message indicates the API key lacks the required scope. */
function isPermissionErrorMessage(message: string): boolean {
  return /permission|forbidden|not authorized|unauthorized|scope/i.test(message)
}

function webhookPermissionError(action: "list" | "create" | "update", cause: string): Error {
  return new Error(
    `Linear API key lacks permission to ${action} webhooks.\n` +
      "  Fix: regenerate your Linear API key at https://linear.app/settings/api with webhook create/manage " +
      "scope, update LINEAR_API_KEY, then re-run `av up`.\n" +
      `  Underlying error: ${cause}`,
  )
}

/**
 * Find av's existing webhook for a team by WEBHOOK_LABEL, falling back
 * to a URL match for webhooks created before labelling was introduced.
 */
async function findExistingWebhook(
  apiKey: string,
  teamId: string,
  url: string,
  label: string,
): Promise<{ id: string; url: string; enabled: boolean } | undefined> {
  try {
    const data = await linearGraphQL<unknown>(apiKey, LIST_WEBHOOKS_QUERY, { teamId })
    const parsed = listWebhooksDataSchema.safeParse(data)
    if (!parsed.success) {
      throw new Error(`Linear webhooks response validation failed: ${parsed.error.message}`)
    }
    const nodes = parsed.data.webhooks?.nodes ?? []
    return nodes.find((w) => w.label === label) ?? nodes.find((w) => w.url === url)
  } catch (err) {
    const msg = (err as Error).message
    if (isPermissionErrorMessage(msg)) throw webhookPermissionError("list", msg)
    throw err
  }
}

/**
 * Create or update av's webhook for a team so its URL points at the
 * live tunnel and its secret matches the configured signing secret.
 * Idempotent: identifies the existing webhook via WEBHOOK_LABEL (or a
 * URL match) so re-running with a new tunnel URL updates it in place
 * instead of creating a duplicate.
 */
export async function upsertWebhook(params: {
  apiKey: string
  teamId: string
  url: string
  secret: string
  label?: string
}): Promise<{ id: string; url: string }> {
  const label = params.label ?? WEBHOOK_LABEL
  const existing = await findExistingWebhook(params.apiKey, params.teamId, params.url, label)

  if (existing) {
    try {
      const data = await linearGraphQL<unknown>(params.apiKey, UPDATE_WEBHOOK_MUTATION, {
        id: existing.id,
        url: params.url,
        enabled: true,
      })
      const parsed = webhookUpdateDataSchema.safeParse(data)
      const webhook = parsed.success ? parsed.data.webhookUpdate?.webhook : undefined
      if (!parsed.success || !parsed.data.webhookUpdate?.success || !webhook) {
        throw new Error(
          `Failed to update Linear webhook: id=${existing.id}, url=${params.url}\n` +
            "  Fix: verify LINEAR_API_KEY still has webhook manage permission for this team.",
        )
      }
      logger.info("tracker-client", "Updated Linear webhook", { teamId: params.teamId, webhookId: webhook.id })
      return webhook
    } catch (err) {
      const msg = (err as Error).message
      if (isPermissionErrorMessage(msg)) throw webhookPermissionError("update", msg)
      throw err
    }
  }

  try {
    const data = await linearGraphQL<unknown>(params.apiKey, CREATE_WEBHOOK_MUTATION, {
      teamId: params.teamId,
      url: params.url,
      secret: params.secret,
      label,
    })
    const parsed = webhookCreateDataSchema.safeParse(data)
    const webhook = parsed.success ? parsed.data.webhookCreate?.webhook : undefined
    if (!parsed.success || !parsed.data.webhookCreate?.success || !webhook) {
      throw new Error(
        `Failed to create Linear webhook: teamId=${params.teamId}, url=${params.url}\n` +
          "  Fix: verify LINEAR_API_KEY has webhook create permission for this team. Regenerate at " +
          "https://linear.app/settings/api if needed.",
      )
    }
    logger.info("tracker-client", "Created Linear webhook", { teamId: params.teamId, webhookId: webhook.id })
    return webhook
  } catch (err) {
    const msg = (err as Error).message
    if (isPermissionErrorMessage(msg)) throw webhookPermissionError("create", msg)
    throw err
  }
}
