/**
 * "none" tunnel adapter — explicit no-op.
 *
 * Use when the operator runs Agent Valley behind an existing reverse
 * proxy, VPN, or pre-configured Cloudflare Tunnel sidecar managed
 * outside this CLI. Selecting `provider: none` prints a single dim log
 * line and returns immediately so `av up` / `av dev` flow is unchanged.
 */

import { nullTunnelHandle, type TunnelHandle, type TunnelSpawnInput } from "./types"

export function spawnNone(input: TunnelSpawnInput): TunnelHandle {
  input.logger.dim("  tunnel.provider=none — skipping tunnel spawn.")
  return nullTunnelHandle()
}
