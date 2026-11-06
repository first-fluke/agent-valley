import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function installHooks({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  env = process.env,
  exists = existsSync,
  run = spawnSync,
} = {}) {
  if ((env.CI && env.CI !== "false" && env.CI !== "0") || !exists(join(root, ".git"))) {
    return 0
  }
  const result = run("mise", ["exec", "--", "hk", "install", "--mise"], {
    cwd: root,
    env: { ...env, MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0" },
    stdio: "inherit",
  })
  if (result.error || result.status !== 0) {
    console.error(
      "Hook setup failed. Install the versions in mise.toml, trust this repository with mise trust, then run bun run prepare.",
    )
    return result.status || 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = installHooks()
}
