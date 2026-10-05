/**
 * `av setup --edit` — partial reconfiguration of an existing install.
 *
 * Loads the current YAML files, lets the user pick which fields to
 * change, re-prompts for those, and writes the merged result back.
 * Behaviour mirrors the pre-split setup.ts for Linear users.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mergeChiefConfig } from "@agent-valley/core/config/chief-schema"
import {
  loadGlobalConfig,
  loadProjectConfig,
  resolveGlobalConfigDir,
  resolveGlobalConfigPath,
} from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { stringify as yamlStringify } from "yaml"
import { installClientIntegrations } from "../client-integrations"
import { stepAgentType } from "./agent-step"
import { stepChief } from "./chief-step"
import { changedProjectChief } from "./chief-write"
import { stepCompletion } from "./completion-step"
import { canonicalConfig } from "./config-write"
import { stepOma } from "./oma-step"
import { BACK, CANCEL, type SetupContext, type StepFn } from "./types"
import { stepWorkspace } from "./workspace-step"

const EDITABLE_FIELDS: { value: string; label: string; scope: "global" | "project" }[] = [
  { value: "apiKey", label: "Linear API Key", scope: "global" },
  { value: "webhookSecret", label: "Tracker Webhook Secret", scope: "project" },
  { value: "workspaceRoot", label: "Workspace Path", scope: "project" },
  { value: "agentType", label: "Chief Director CLI and model", scope: "global" },
  { value: "oma", label: "OMA skills (install/update)", scope: "project" },
  { value: "completion", label: "Task output and verification", scope: "project" },
  { value: "chief", label: "Reports, browser capture, metrics and container observation", scope: "project" },
]

export async function setupEdit(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup — Edit ")))

  const globalConfig = loadGlobalConfig()
  const projectConfig = loadProjectConfig()
  const isGithub = projectConfig?.tracker?.kind === "github" || (!projectConfig?.linear && !!projectConfig?.github)
  const isOrder = !!projectConfig && !projectConfig.tracker && !projectConfig.linear && !projectConfig.github
  const trackerKind = isOrder ? "none" : isGithub ? "github" : "linear"

  if (!globalConfig && !projectConfig) {
    p.log.error("No config files found. Run `bun av setup` first.")
    process.exit(1)
  }

  const fields = await p.multiselect({
    message: "Select fields to change",
    options: EDITABLE_FIELDS.filter((field) => {
      if (isOrder && (field.value === "apiKey" || field.value === "webhookSecret")) return false
      return !isGithub || field.value !== "apiKey"
    }).map((f) => ({
      value: f.value,
      label: `${f.label} ${pc.dim(`(${f.scope})`)}`,
    })),
    required: true,
  })
  if (p.isCancel(fields)) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  const selectedFields = fields as string[]
  let globalChanged = false
  let projectChanged = false

  const gConfig = globalConfig ?? {}
  const pConfig = projectConfig ?? {}

  if (selectedFields.includes("apiKey")) {
    const apiKey = await p.text({
      message: "Linear API Key",
      placeholder: "lin_api_xxx",
      initialValue: gConfig.linear?.api_key,
      validate: (v) => {
        if (!v) return "Required"
        if (!v.startsWith("lin_api_")) return "Must start with lin_api_"
      },
    })
    if (p.isCancel(apiKey)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (!gConfig.linear) gConfig.linear = {}
    gConfig.linear.api_key = apiKey
    globalChanged = true
  }

  if (selectedFields.includes("webhookSecret")) {
    const secret = await p.text({
      message: "Webhook Signing Secret",
      placeholder: "lin_wh_xxx",
      initialValue: isGithub ? pConfig.github?.webhook_secret : pConfig.linear?.webhook_secret,
      validate: (v) => {
        if (!v) return "Required"
      },
    })
    if (p.isCancel(secret)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (isGithub) {
      if (!pConfig.github) pConfig.github = {}
      pConfig.github.webhook_secret = secret
    } else {
      if (!pConfig.linear) pConfig.linear = {}
      pConfig.linear.webhook_secret = secret
    }
    projectChanged = true
  }

  if (selectedFields.some((field) => ["workspaceRoot", "agentType", "oma"].includes(field))) {
    const context: SetupContext = {
      trackerKind,
      workspaceRoot: pConfig.workspace?.root,
      agentType: gConfig.agent?.type,
      agentModel: gConfig.agent?.model,
    }
    const prepareSteps: StepFn[] = []
    if (selectedFields.includes("workspaceRoot") || !context.workspaceRoot) prepareSteps.push(stepWorkspace)
    if (selectedFields.includes("agentType")) prepareSteps.push(stepAgentType)
    prepareSteps.push(stepOma)
    let index = 0
    while (index < prepareSteps.length) {
      const current = prepareSteps[index]
      if (!current) break
      const result = await current(context, index + 1, prepareSteps.length)
      if (result === CANCEL) {
        p.cancel("Cancelled")
        process.exit(0)
      }
      if (result === BACK) {
        if (index === 0) return setupEdit()
        index--
        continue
      }
      index++
    }
    if (selectedFields.includes("workspaceRoot") || !pConfig.workspace?.root) {
      if (!pConfig.workspace) pConfig.workspace = {}
      pConfig.workspace.root = context.workspaceRoot
      projectChanged = true
    }
    if (selectedFields.includes("agentType")) {
      if (!gConfig.agent) gConfig.agent = {}
      gConfig.agent.type = context.agentType
      if (context.agentModel) gConfig.agent.model = context.agentModel
      else delete gConfig.agent.model
      globalChanged = true
    }
  }

  if (selectedFields.includes("completion")) {
    const context: SetupContext = { trackerKind, task: pConfig.task, verifyCommand: pConfig.verify?.command }
    if ((await stepCompletion(context, 1, 1)) === CANCEL) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    pConfig.task = context.task
    pConfig.verify = context.verifyCommand ? { ...pConfig.verify, command: context.verifyCommand } : undefined
    projectChanged = true
  }

  if (selectedFields.includes("chief")) {
    const context: SetupContext = { chief: mergeChiefConfig(gConfig.chief, pConfig.chief) }
    const result = await stepChief(context, 1, 1)
    if (result === BACK) return setupEdit()
    if (result === CANCEL) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (context.chiefChanged) {
      pConfig.chief = changedProjectChief(gConfig.chief, pConfig.chief, context.chief)
      projectChanged = true
    }
  }

  const confirmed = await p.confirm({ message: "Save changes?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  if (globalChanged) {
    const globalDir = resolveGlobalConfigDir()
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true })
    writeFileSync(resolveGlobalConfigPath(), yamlStringify(canonicalConfig(gConfig), { lineWidth: 0 }), "utf-8")
    p.log.success(`Global config updated: ${resolveGlobalConfigPath()}`)
  }

  if (projectChanged) {
    writeFileSync("av.yaml", yamlStringify(canonicalConfig(pConfig), { lineWidth: 0 }), "utf-8")
    p.log.success("Project config updated: av.yaml")
  }

  if (selectedFields.includes("workspaceRoot") && pConfig.workspace?.root)
    await installClientIntegrations(pConfig.workspace.root, { projectRoot: process.cwd() })

  p.outro(pc.green("Configuration updated!"))
}
