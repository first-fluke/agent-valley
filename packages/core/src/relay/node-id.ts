/**
 * Node ID generation — "{authenticated-user-uuid}:{hostname}" format.
 * The UUID prefix is checked by the team ledger RLS insert policy.
 */

import { hostname } from "node:os"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function generateNodeId(authenticatedUserId: string): string {
  if (!UUID_PATTERN.test(authenticatedUserId)) {
    throw new Error("Team ledger user ID must be a UUID from av login. Fix: Run 'av login' again and restart Symphony.")
  }
  const machine = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
  return `${authenticatedUserId.toLowerCase()}:${machine}`
}
