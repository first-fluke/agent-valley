import { lstat } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join } from "node:path"

interface ParallelBuildRule {
  envVar: string
  manifests: readonly string[]
}

const PARALLEL_BUILD_RULES: readonly ParallelBuildRule[] = [
  { envVar: "CARGO_BUILD_JOBS", manifests: ["Cargo.toml"] },
  { envVar: "GOMAXPROCS", manifests: ["go.mod"] },
  { envVar: "CMAKE_BUILD_PARALLEL_LEVEL", manifests: ["CMakeLists.txt"] },
  { envVar: "UV_CONCURRENT_BUILDS", manifests: ["pyproject.toml", "uv.lock"] },
]

async function hasAnyManifest(root: string, manifests: readonly string[]): Promise<boolean> {
  const stats = await Promise.all(manifests.map((name) => lstat(join(root, name)).catch(() => undefined)))
  return stats.some((entry) => entry?.isFile() === true)
}

/**
 * Cap per-workspace build tool parallelism when multiple isolated Actors compile concurrently on
 * the same host, preventing CPU/RAM swap thrashing across Rust, Go, CMake, and Python/uv projects.
 * Leaves single-slot runs, workspaces without matching manifests, and explicit operator env vars untouched.
 */
export async function parallelBuildJobsEnvironment(
  root: string,
  parallelSlots: number | undefined,
  source: NodeJS.ProcessEnv = process.env,
  cpuCount: number = availableParallelism(),
): Promise<Record<string, string>> {
  if (!parallelSlots || !Number.isFinite(parallelSlots) || parallelSlots <= 1) return {}
  const cpus = Number.isFinite(cpuCount) && cpuCount >= 1 ? cpuCount : 1
  const jobs = String(Math.max(1, Math.floor(cpus / Math.floor(parallelSlots))))
  const eligible = PARALLEL_BUILD_RULES.filter((rule) => source[rule.envVar] === undefined)
  if (eligible.length === 0) return {}
  const matches = await Promise.all(eligible.map((rule) => hasAnyManifest(root, rule.manifests)))
  const env: Record<string, string> = {}
  for (let i = 0; i < eligible.length; i += 1) {
    const rule = eligible[i]
    if (rule && matches[i]) env[rule.envVar] = jobs
  }
  return env
}
