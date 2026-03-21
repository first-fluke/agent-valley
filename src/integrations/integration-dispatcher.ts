/**
 * IntegrationDispatcher — Routes IntegrationEvents to all configured integrations.
 */

import type { IntegrationEvent, IntegrationStatus } from "../domain/models"
import { logger } from "../observability/logger"
import type { Integration } from "./types"

const COMPONENT = "IntegrationDispatcher"

export class IntegrationDispatcher {
  private readonly integrations: Integration[]

  constructor(integrations: Integration[]) {
    this.integrations = integrations
  }

  get count(): number {
    return this.integrations.length
  }

  statuses(): IntegrationStatus[] {
    return this.integrations.map((i) => i.status())
  }

  async dispatch(event: IntegrationEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.integrations.map((i) => i.notify(event)),
    )

    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        const integration = this.integrations[idx]!
        logger.error(COMPONENT, "Integration notification failed", {
          integrationType: integration.type,
          issueId: event.issueId,
          kind: event.kind,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })
  }
}
