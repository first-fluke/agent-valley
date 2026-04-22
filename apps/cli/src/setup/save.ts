/**
 * Persist the resolved setup context to disk.
 *
 * Two files are written:
 *   - `~/.config/agent-valley/settings.yaml` (global — agent type + optional
 *     Linear API key). GitHub tokens are **never** written here.
 *   - `./valley.yaml` (project — tracker config + workspace + prompt).
 *
 * Post-save, the caller is responsible for surfacing the env-var export
 * hint for GitHub setups (see index.ts).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolveGlobalConfigDir, resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import type { ResolvedSetupContext } from "./resolve"
import { buildGlobalYaml, buildGlobalYamlGithub, buildProjectYaml, buildProjectYamlGithub } from "./yaml-build"

export async function saveConfig(ctx: ResolvedSetupContext): Promise<void> {
  // ── Global config ──────────────────────────────────────────────────
  const globalDir = resolveGlobalConfigDir()
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true })
  }

  const globalContent =
    ctx.trackerKind === "linear"
      ? buildGlobalYaml({
          apiKey: ctx.linear.apiKey,
          agentType: ctx.agentType,
          maxParallel: ctx.maxParallel,
        })
      : buildGlobalYamlGithub({
          agentType: ctx.agentType,
          maxParallel: ctx.maxParallel,
        })

  writeFileSync(resolveGlobalConfigPath(), globalContent, "utf-8")
  p.log.success(`Global config saved: ${resolveGlobalConfigPath()}`)

  // ── Project config ─────────────────────────────────────────────────
  const projectContent =
    ctx.trackerKind === "linear"
      ? buildProjectYaml({
          teamKey: ctx.linear.selectedTeam.key,
          teamUuid: ctx.linear.teamUuid,
          webhookSecret: ctx.linear.webhookSecret,
          todoStateId: ctx.linear.todoStateId,
          inProgressStateId: ctx.linear.inProgressStateId,
          doneStateId: ctx.linear.doneStateId,
          cancelledStateId: ctx.linear.cancelledStateId,
          workspaceRoot: ctx.workspaceRoot,
        })
      : buildProjectYamlGithub({
          tokenEnv: ctx.github.tokenEnv,
          owner: ctx.github.owner,
          repo: ctx.github.repo,
          webhookSecret: ctx.github.webhookSecret,
          labels: ctx.github.labels,
          workspaceRoot: ctx.workspaceRoot,
        })

  writeFileSync("valley.yaml", projectContent, "utf-8")
  p.log.success("Project config saved: valley.yaml")

  // ── Workspace directory ────────────────────────────────────────────
  if (!existsSync(ctx.workspaceRoot)) {
    mkdirSync(ctx.workspaceRoot, { recursive: true })
    p.log.success(`Workspace directory created: ${ctx.workspaceRoot}`)
  }
}
