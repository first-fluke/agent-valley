/**
 * Build script — bundles CLI + supervisor into dist/ for npm distribution.
 *
 * - Inlines all dependencies (including workspace @agent-valley/core)
 * - Outputs Node.js-compatible ESM with #!/usr/bin/env node shebang
 */

import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyClientSkillAsset } from "./src/client-integrations-assets"
import { stageNpmDistribution } from "./src/npm-distribution"
import { copyPluginLicenseAsset, copyPluginManifestAsset } from "./src/plugin-assets"

const cliRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(cliRoot, "../..")
const output = resolve(cliRoot, "dist")
rmSync(output, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [resolve(cliRoot, "src/index.ts"), resolve(cliRoot, "src/supervisor.ts")],
  outdir: output,
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  packages: "bundle",
  banner: "#!/usr/bin/env node",
})

if (!result.success) throw new AggregateError(result.logs, "CLI bundling failed; no npm distribution was prepared.")

await copyClientSkillAsset(output)
await copyPluginManifestAsset(output)
await copyPluginLicenseAsset(output)
const npmRoot = await stageNpmDistribution(cliRoot, repositoryRoot)

console.log(`Built CLI + supervisor + client/plugin assets. Publish the standalone package from ${npmRoot}.`)
