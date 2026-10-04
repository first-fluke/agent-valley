import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { parse } from "yaml"
import type { AgentAvailability } from "../../agent-discovery"
import { prepareClientIntegrations } from "../../client-integrations"
import { applyIntegrationFiles } from "../../client-integrations-files"
import type { AgentType } from "../../setup/types"

export function createSetupRepository(path: string, committed = true): void {
  mkdirSync(path, { recursive: true })
  const options = { cwd: path, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }
  execFileSync("git", ["init", "--quiet"], options)
  if (committed)
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      options,
    )
}

export function noninteractiveFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-headless-")))
  const projectRoot = join(root, "configuration")
  const workspace = join(root, "target")
  createSetupRepository(projectRoot)
  createSetupRepository(workspace)
  const globalConfigPath = join(root, "xdg", "agent-valley", "settings.yaml")
  const projectPath = join(projectRoot, "av.yaml")
  const deps = {
    projectRoot,
    globalConfigPath,
    env: {} as Record<string, string | undefined>,
    inspectActor: vi.fn(
      async (actor: AgentType): Promise<AgentAvailability> => ({
        agentType: actor,
        readiness: "ready" as const,
        reason: "Mock authenticated CLI",
      }),
    ),
    installActor: vi.fn(async () => ({ success: true, message: "Mock CLI installation completed" })),
    prepareOma: vi.fn(async () => ({ success: true, message: "Mock OMA preparation completed" })),
    prepareIntegrations: vi.fn((target: string, project: string) =>
      prepareClientIntegrations(target, { projectRoot: project }),
    ),
    applyFiles: vi.fn(applyIntegrationFiles),
  }
  const write = (path: string, content: string) => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content)
  }
  return {
    root,
    workspace,
    projectPath,
    globalConfigPath,
    deps,
    write,
    json: (path: string) => parse(readFileSync(path, "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
