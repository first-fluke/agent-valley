/**
 * Persist the resolved setup context to disk.
 *
 * Two files are written:
 *   - `~/.config/agent-valley/settings.yaml` (global — agent type + optional
 *     Linear API key). GitHub tokens are **never** written here.
 *   - `./av.yaml` (project — tracker config + workspace + prompt).
 *
 * Post-save, the caller is responsible for surfacing the env-var export
 * hint for GitHub setups (see index.ts).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import { readYamlFile } from "@agent-valley/core/config/yaml-file"
import {
  loadGlobalConfig,
  resolveGlobalConfigDir,
  resolveGlobalConfigPath,
} from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { changedProjectChief } from "./chief-write"
import { canonicalConfig } from "./config-write"
import { readSetupGlobalConfig } from "./global-settings"
import type { ResolvedSetupContext } from "./resolve"
import { validateOrderWorkspace } from "./workspace-step"
import {
  buildGlobalYaml,
  buildGlobalYamlGithub,
  buildProjectYaml,
  buildProjectYamlGithub,
  buildProjectYamlOrder,
} from "./yaml-build"

export async function saveConfig(
  ctx: ResolvedSetupContext,
  options: { replaceInvalidGlobal?: boolean; replaceInvalidProject?: boolean } = {},
): Promise<void> {
  if (ctx.trackerKind === "none") {
    const workspaceError = await validateOrderWorkspace(ctx.workspaceRoot)
    if (workspaceError) throw new Error(workspaceError)
  }
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
          agentModel: ctx.agentModel,
          maxParallel: ctx.maxParallel,
        })
      : buildGlobalYamlGithub({
          agentType: ctx.agentType,
          agentModel: ctx.agentModel,
          maxParallel: ctx.maxParallel,
        })

  const existing = options.replaceInvalidGlobal ? readSetupGlobalConfig().config : (loadGlobalConfig() ?? {})
  const generated = parseYaml(globalContent)
  const merged = {
    ...existing,
    ...generated,
    logging: existing.logging ?? generated.logging,
    server: existing.server ?? generated.server,
    agent: { ...existing.agent, ...generated.actor },
  }
  if (!ctx.agentModel?.trim()) delete merged.agent.model
  writeFileSync(resolveGlobalConfigPath(), stringifyYaml(canonicalConfig(merged), { lineWidth: 0 }), {
    encoding: "utf-8",
    mode: 0o600,
  })
  chmodSync(resolveGlobalConfigPath(), 0o600)
  p.log.success(`Global config saved: ${resolveGlobalConfigPath()}`)

  // ── Project config ─────────────────────────────────────────────────
  const projectContent =
    ctx.trackerKind === "none"
      ? buildProjectYamlOrder({
          workspaceRoot: ctx.workspaceRoot,
          verifyCommand: ctx.verifyCommand,
          task: ctx.task,
        })
      : ctx.trackerKind === "linear"
        ? buildProjectYaml({
            teamKey: ctx.linear.selectedTeam.key,
            teamUuid: ctx.linear.teamUuid,
            webhookSecret: ctx.linear.webhookSecret,
            todoStateId: ctx.linear.todoStateId,
            inProgressStateId: ctx.linear.inProgressStateId,
            doneStateId: ctx.linear.doneStateId,
            cancelledStateId: ctx.linear.cancelledStateId,
            workspaceRoot: ctx.workspaceRoot,
            tunnel: ctx.tunnel,
            task: ctx.task,
            verifyCommand: ctx.verifyCommand,
          })
        : buildProjectYamlGithub({
            tokenEnv: ctx.github.tokenEnv,
            owner: ctx.github.owner,
            repo: ctx.github.repo,
            webhookSecret: ctx.github.webhookSecret,
            labels: ctx.github.labels,
            workspaceRoot: ctx.workspaceRoot,
            tunnel: ctx.tunnel,
            task: ctx.task,
            verifyCommand: ctx.verifyCommand,
          })

  const existingChief = options.replaceInvalidProject ? undefined : readYamlFile("av.yaml")?.chief
  const chief = ctx.chiefChanged
    ? changedProjectChief(
        existing.chief,
        existingChief === undefined ? undefined : chiefConfigSchema.parse(existingChief),
        ctx.chief,
      )
    : existingChief
  const savedProject =
    chief === undefined
      ? projectContent
      : stringifyYaml(
          {
            ...parseYaml(projectContent),
            chief: chiefConfigSchema.parse(chief),
          },
          { lineWidth: 0 },
        )
  writeFileSync("av.yaml", savedProject, { encoding: "utf-8", mode: 0o600 })
  chmodSync("av.yaml", 0o600)
  p.log.success("Project config saved: av.yaml")

  // ── Workspace directory ────────────────────────────────────────────
  if (ctx.trackerKind !== "none" && !existsSync(ctx.workspaceRoot)) {
    mkdirSync(ctx.workspaceRoot, { recursive: true })
    p.log.success(`Workspace directory created: ${ctx.workspaceRoot}`)
  }

  if (ctx.trackerKind !== "none" && !ctx.verifyCommand && ctx.task?.kind !== "analysis")
    p.note(
      [
        "Before starting work, set verify.command in av.yaml to a check that exists in this project.",
        "For report-only work, configure task.kind: analysis and task.report_path with {{attempt.id}} instead.",
        "Run av doctor to confirm the completion configuration.",
      ].join("\n"),
      "Required completion setup",
    )
}
