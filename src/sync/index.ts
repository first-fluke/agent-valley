/**
 * Sync — Barrel export and factory for inbound data sync services.
 */

export { SyncService } from "./sync-service"
export { verifyGitHubSignature, parseGitHubWebhookEvent } from "./github-webhook-handler"

import type { Config } from "../config/config"
import { SyncService } from "./sync-service"

export function createSyncService(config: Config): SyncService {
  return new SyncService(config)
}
