/**
 * Cloudflare Tunnel adapter.
 *
 * Two modes:
 *
 * 1. quick — spawns `cloudflared tunnel --url http://localhost:{port}
 *    --logformat json`. Cloudflare mints a random trycloudflare.com
 *    subdomain per launch. No account or DNS setup required. The URL is
 *    discovered by scanning the child's stdout/stderr for the first
 *    https URL ending in `.trycloudflare.com`.
 *
 * 2. named — assumes the operator has already registered a tunnel via
 *    `cloudflared tunnel create <name>` and pointed a DNS record at it.
 *    We spawn `cloudflared tunnel run <name>` and resolve `ready` with
 *    the configured `hostname` (or `null` when no hostname was set).
 *
 * Prompt-injection / network-egress notes (SAFETY.md §2):
 *   - We never pass user-controlled strings into `spawn` via a shell.
 *     `cloudflared` is invoked with an argv array so shell metacharacters
 *     in `name`/`hostname` cannot break out.
 *   - The adapter only starts a tunnel; it does not probe any HTTP
 *     endpoint. All Cloudflare API traffic is initiated by cloudflared
 *     itself against its own approved endpoints.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import type { TunnelConfig } from "@agent-valley/core/config/yaml-loader"
import { nullTunnelHandle, type TunnelHandle, type TunnelLogger, type TunnelSpawnInput } from "./types"

/**
 * Matches any https URL containing `.trycloudflare.com`. Cloudflare
 * prints the URL inside an ASCII-art box so we cannot rely on a fixed
 * prefix; a tight regex on the hostname suffix is enough and avoids
 * false positives on any other https URL that might appear in the logs.
 */
const TRYCLOUDFLARE_URL_RE = /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/

export function spawnCloudflare(cfg: TunnelConfig["cloudflare"], input: TunnelSpawnInput): TunnelHandle {
  const { port, logger } = input

  const which = spawnSync("which", ["cloudflared"])
  if (which.status !== 0) {
    emitMissingBinaryWarning(logger)
    return nullTunnelHandle()
  }

  if (cfg.mode === "named") {
    return spawnNamed(cfg, logger)
  }
  return spawnQuick(port, logger)
}

function spawnQuick(port: string, logger: TunnelLogger): TunnelHandle {
  const proc = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`, "--logformat", "json", "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  )

  const ready = extractQuickUrl(proc, logger)

  return {
    child: proc,
    ready,
    kill: () => killTree(proc),
  }
}

function spawnNamed(cfg: TunnelConfig["cloudflare"], logger: TunnelLogger): TunnelHandle {
  // Schema guarantees name is present when mode === "named"; guard defensively.
  if (!cfg.name) {
    logger.warn("⚠ tunnel.cloudflare.mode=named requires tunnel.cloudflare.name in valley.yaml.")
    logger.dim("  Fix: add tunnel.cloudflare.name: <tunnel-name> or switch mode to 'quick'.")
    return nullTunnelHandle()
  }

  const proc = spawn("cloudflared", ["tunnel", "run", cfg.name, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  const hostname = cfg.hostname ?? null
  if (hostname) {
    logger.info(`▶ cloudflared (named:${cfg.name}) → https://${hostname}`)
    logger.dim(`  Webhook URL: https://${hostname}/api/webhook`)
  } else {
    logger.info(`▶ cloudflared (named:${cfg.name}) running`)
    logger.dim("  Set tunnel.cloudflare.hostname in valley.yaml to print the webhook URL.")
  }

  const ready: Promise<string | null> = new Promise((resolvePromise) => {
    const url = hostname ? `https://${hostname}` : null
    // Settle immediately — named tunnels have no URL probe.
    resolvePromise(url)
    proc.on("exit", () => {
      /* noop — ready already settled */
    })
  })

  return {
    child: proc,
    ready,
    kill: () => killTree(proc),
  }
}

function extractQuickUrl(proc: ChildProcess, logger: TunnelLogger): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    let settled = false
    const settle = (url: string | null) => {
      if (settled) return
      settled = true
      resolvePromise(url)
    }

    const handleChunk = (chunk: Buffer) => {
      if (settled) return
      // cloudflared emits JSON lines on stderr in recent releases and on
      // stdout in older ones; we scan both. The URL we want is either a
      // JSON field (`msg` contains it) or printed as part of the banner
      // box. A single regex on the raw text handles both cases.
      const text = chunk.toString()
      const match = text.match(TRYCLOUDFLARE_URL_RE)
      if (match) {
        const url = match[0]
        logger.info(`▶ cloudflared (quick) → ${url}`)
        logger.dim(`  Webhook URL: ${url}/api/webhook`)
        settle(url)
      }
    }

    proc.stdout?.on("data", handleChunk)
    proc.stderr?.on("data", handleChunk)
    proc.on("exit", () => settle(null))
    proc.on("error", () => settle(null))
  })
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    try {
      proc.kill("SIGTERM")
    } catch {
      /* ignore — already gone */
    }
  }
}

function emitMissingBinaryWarning(logger: TunnelLogger): void {
  logger.warn("⚠ cloudflared not found — Linear webhooks won't reach localhost")
  logger.dim("  Fix: install cloudflared (brew install cloudflared —")
  logger.dim("        https://github.com/cloudflare/cloudflared/releases)")
  logger.dim("  Or fall back: set tunnel.provider: ngrok in valley.yaml.")
}
