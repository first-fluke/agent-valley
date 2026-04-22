/**
 * ngrok tunnel adapter.
 *
 * Behaviour preserved from the pre-v0.3 inline `spawnNgrok` helper:
 *   - Requires `ngrok` on PATH. If missing, warn with an actionable fix
 *     and return a null-handle so the caller keeps running.
 *   - Streams the child's stdout (`--log stdout --log-format json`) and
 *     extracts the first `https://` URL Linear can reach.
 *   - Runs detached so `av up` can background the process.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { nullTunnelHandle, type TunnelHandle, type TunnelLogger, type TunnelSpawnInput } from "./types"

export function spawnNgrok(input: TunnelSpawnInput): TunnelHandle {
  const { port, logger } = input

  const which = spawnSync("which", ["ngrok"])
  if (which.status !== 0) {
    emitMissingBinaryWarning(logger)
    return nullTunnelHandle()
  }

  const proc = spawn("ngrok", ["http", port, "--log", "stdout", "--log-format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  const ready = attachUrlExtractor(proc, logger)

  return {
    child: proc,
    ready,
    kill: () => killTree(proc),
  }
}

function attachUrlExtractor(proc: ChildProcess, logger: TunnelLogger): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    let settled = false
    const settle = (url: string | null) => {
      if (settled) return
      settled = true
      resolvePromise(url)
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue
        try {
          const log = JSON.parse(line) as { url?: string }
          if (log.url?.startsWith("https://")) {
            logger.info(`▶ ngrok → ${log.url}`)
            logger.dim(`  Webhook URL: ${log.url}/api/webhook`)
            settle(log.url)
            return
          }
        } catch {
          // Not JSON — skip.
        }
      }
    })

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
  logger.warn("⚠ ngrok not found — Linear webhooks won't reach localhost")
  logger.dim("  Fix: install ngrok (brew install ngrok — https://ngrok.com/download)")
  logger.dim("  Alternative: set tunnel.provider: cloudflare in valley.yaml to use Cloudflare Tunnel.")
}
