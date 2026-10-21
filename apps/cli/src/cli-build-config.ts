import { resolve } from "node:path"
import { externalRuntimePackages } from "./npm-distribution"

/** The native driver keeps its platform packages; application and ORM code remain bundled. */
export function cliBuildConfig(cliRoot: string): Bun.BuildConfig {
  return {
    entrypoints: [resolve(cliRoot, "src/index.ts"), resolve(cliRoot, "src/supervisor.ts")],
    outdir: resolve(cliRoot, "dist"),
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
    packages: "bundle",
    external: externalRuntimePackages.flatMap((name) => [name, `${name}/*`]),
    banner: "#!/usr/bin/env node",
  }
}
