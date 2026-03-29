/**
 * Build script — bundles CLI + supervisor into dist/ for npm distribution.
 *
 * - Inlines all dependencies (including workspace @agent-valley/core)
 * - Outputs Node.js-compatible ESM with #!/usr/bin/env node shebang
 */

import { rmSync } from "node:fs"

rmSync("dist", { recursive: true, force: true })

// Main CLI entry point
await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  packages: "bundle",
  banner: "#!/usr/bin/env node",
})

// Supervisor (spawned as separate process by `av up`)
await Bun.build({
  entrypoints: ["src/supervisor.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  packages: "bundle",
  banner: "#!/usr/bin/env node",
})

console.log("Built dist/index.js + dist/supervisor.js")
