/**
 * Tunnel schema — public URL tunnel for webhook receivers.
 *
 * Two dimensions:
 *   - provider: which binary (cloudflare / ngrok) spawns the tunnel,
 *     or `none` to disable tunnel management entirely.
 *   - cloudflare.mode: quick (on-demand trycloudflare.com URL) or
 *     named (pre-registered tunnel whose hostname is in DNS).
 *
 * Backwards compat: when the top-level `tunnel:` block is omitted,
 * provider defaults to `ngrok` so existing valley.yaml files keep the
 * v0.2 behaviour.
 *
 * Pure Zod + type definitions. No I/O, no process spawning.
 */

import { z } from "zod"

export const tunnelCloudflareProjectSchema = z
  .object({
    mode: z.enum(["quick", "named"]).optional(),
    name: z.string().min(1).optional(),
    hostname: z.string().min(1).optional(),
  })
  .optional()

export const tunnelProjectSchema = z
  .object({
    provider: z.enum(["cloudflare", "ngrok", "none"]).optional(),
    cloudflare: tunnelCloudflareProjectSchema,
  })
  .optional()
  .superRefine((cfg, ctx) => {
    if (!cfg) return
    if (cfg.provider === "cloudflare" && cfg.cloudflare?.mode === "named") {
      if (!cfg.cloudflare.name) {
        ctx.addIssue({
          code: "custom",
          path: ["cloudflare", "name"],
          message:
            "tunnel.cloudflare.name is required when tunnel.cloudflare.mode === 'named'.\n" +
            "  Fix: Add tunnel.cloudflare.name: <tunnel-name> to valley.yaml, " +
            "or switch tunnel.cloudflare.mode to 'quick'.",
        })
      }
    }
  })

export type TunnelProjectConfig = z.infer<typeof tunnelProjectSchema>

/** Shape emitted into the merged Config object consumed by the CLI. */
export const tunnelMergedSchema = z.object({
  provider: z.enum(["cloudflare", "ngrok", "none"]),
  cloudflare: z.object({
    mode: z.enum(["quick", "named"]),
    name: z.string().optional(),
    hostname: z.string().optional(),
  }),
})

export type TunnelConfig = z.infer<typeof tunnelMergedSchema>

/**
 * Normalise the (optional) project tunnel block to the strict merged
 * schema shape. Returns the ngrok-default when the project file omits
 * the block entirely.
 */
export function buildTunnelConfig(project: { tunnel?: TunnelProjectConfig } | null | undefined): TunnelConfig {
  const tunnel = project?.tunnel
  return {
    provider: tunnel?.provider ?? "ngrok",
    cloudflare: {
      mode: tunnel?.cloudflare?.mode ?? "quick",
      name: tunnel?.cloudflare?.name,
      hostname: tunnel?.cloudflare?.hostname,
    },
  }
}
