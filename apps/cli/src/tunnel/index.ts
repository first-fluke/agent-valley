/**
 * Tunnel dispatcher — single entry point for `av up` / `av dev`.
 *
 * Resolves `tunnel.provider` from the merged config and delegates to the
 * matching adapter. Each adapter returns a uniform `TunnelHandle` so the
 * caller never needs to special-case providers.
 *
 * Public surface:
 *   - `spawnTunnel(config, input)` — main entry
 *   - `TunnelHandle`, `TunnelSpawnInput`, `TunnelLogger` — types
 *   - `spawnNgrok`, `spawnCloudflare`, `spawnNone` — direct access for
 *     integration tests and advanced callers
 */

import type { TunnelConfig } from "@agent-valley/core/config/yaml-loader"
import { spawnCloudflare } from "./cloudflare"
import { spawnNgrok } from "./ngrok"
import { spawnNone } from "./none"
import type { TunnelHandle, TunnelSpawnInput } from "./types"

export { spawnCloudflare } from "./cloudflare"
export { spawnNgrok } from "./ngrok"
export { spawnNone } from "./none"
export type { TunnelHandle, TunnelLogger, TunnelSpawnInput } from "./types"
export { nullTunnelHandle } from "./types"

/**
 * Spawn the tunnel selected by the merged config.
 *
 * Returns a `TunnelHandle` regardless of provider. The caller inspects
 * `handle.child` (nullable — no-op providers return `null`) and awaits
 * `handle.ready` when it wants the public URL.
 */
export function spawnTunnel(config: TunnelConfig, input: TunnelSpawnInput): TunnelHandle {
  switch (config.provider) {
    case "cloudflare":
      return spawnCloudflare(config.cloudflare, input)
    case "ngrok":
      return spawnNgrok(input)
    case "none":
      return spawnNone(input)
    default: {
      // Exhaustiveness guard — new providers must extend the switch.
      const never: never = config.provider
      throw new Error(
        `Unknown tunnel.provider: ${JSON.stringify(never)}.\n` +
          "  Fix: set tunnel.provider to one of cloudflare | ngrok | none in valley.yaml.",
      )
    }
  }
}
