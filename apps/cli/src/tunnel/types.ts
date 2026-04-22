/**
 * Tunnel abstraction — shared types for webhook URL tunnels.
 *
 * The CLI spawns exactly one tunnel per `av up` / `av dev` process. The
 * tunnel module hides provider differences (ngrok, cloudflared, none)
 * behind a single `TunnelHandle` shape so the caller can treat every
 * provider identically: start, learn the public URL, stop.
 *
 * Layer: Presentation (CLI). No business logic lives here.
 */

import type { ChildProcess } from "node:child_process"

/**
 * Minimal logger surface used by tunnel adapters. Accepts the app's
 * picocolors-based logger or any structured-logger shim the caller wires
 * in. Kept narrow so tests can pass plain functions.
 */
export interface TunnelLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  dim: (msg: string) => void
}

/**
 * Input passed to every `spawn<Provider>` implementation. The port is the
 * local port the dashboard listens on; the tunnel proxies to it.
 */
export interface TunnelSpawnInput {
  port: string
  logger: TunnelLogger
}

/**
 * Lifecycle handle returned by every provider.
 *
 * - `child` is `null` when the provider chose not to spawn a process
 *   (e.g. the binary is missing, or provider === "none"). Callers must
 *   treat `null` as "no-op" and keep running.
 * - `ready` resolves with the public URL when one is known. For named
 *   Cloudflare tunnels the URL is the configured hostname (no probe is
 *   performed). Resolves to `null` when no URL can be surfaced (missing
 *   binary, graceful degrade, provider === "none").
 * - `kill` must be idempotent and safe to call when `child` is null.
 */
export interface TunnelHandle {
  child: ChildProcess | null
  ready: Promise<string | null>
  kill: () => void
}

/**
 * A no-op handle. Used by `none` provider and by adapters that gracefully
 * degrade (e.g. binary not on PATH). Keeps the call-site branch-free.
 */
export function nullTunnelHandle(): TunnelHandle {
  return {
    child: null,
    ready: Promise.resolve(null),
    kill: () => {
      /* no-op */
    },
  }
}
