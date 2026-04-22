/**
 * `av setup --edit` — partial reconfiguration of an existing install.
 *
 * Loads the current YAML files, lets the user pick which fields to
 * change, re-prompts for those, and writes the merged result back.
 * Behaviour mirrors the pre-split setup.ts for Linear users.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import {
  loadGlobalConfig,
  loadProjectConfig,
  resolveGlobalConfigDir,
  resolveGlobalConfigPath,
} from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { stringify as yamlStringify } from "yaml"

const EDITABLE_FIELDS: { value: string; label: string; scope: "global" | "project" }[] = [
  { value: "apiKey", label: "Linear API Key", scope: "global" },
  { value: "webhookSecret", label: "Linear Webhook Secret", scope: "project" },
  { value: "workspaceRoot", label: "Workspace Path", scope: "project" },
  { value: "agentType", label: "Agent Type", scope: "global" },
]

export async function setupEdit(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup — Edit ")))

  const globalConfig = loadGlobalConfig()
  const projectConfig = loadProjectConfig()

  if (!globalConfig && !projectConfig) {
    p.log.error("No config files found. Run `bun av setup` first.")
    process.exit(1)
  }

  const fields = await p.multiselect({
    message: "Select fields to change",
    options: EDITABLE_FIELDS.map((f) => ({ value: f.value, label: `${f.label} ${pc.dim(`(${f.scope})`)}` })),
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
      initialValue: pConfig.linear?.webhook_secret,
      validate: (v) => {
        if (!v) return "Required"
      },
    })
    if (p.isCancel(secret)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (!pConfig.linear) pConfig.linear = {}
    pConfig.linear.webhook_secret = secret
    projectChanged = true
  }

  if (selectedFields.includes("workspaceRoot")) {
    const root = await p.text({
      message: "Agent workspace path (absolute)",
      initialValue: pConfig.workspace?.root,
      validate: (v) => {
        if (!v) return "Required"
        if (!v.startsWith("/")) return "Must be an absolute path"
      },
    })
    if (p.isCancel(root)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (!pConfig.workspace) pConfig.workspace = {}
    pConfig.workspace.root = root
    projectChanged = true
  }

  if (selectedFields.includes("agentType")) {
    const agent = await p.select({
      message: "Select agent",
      options: [
        { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
        { value: "codex", label: "Codex", hint: "OpenAI Codex" },
        { value: "gemini", label: "Gemini", hint: "Google Gemini" },
      ],
    })
    if (p.isCancel(agent)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (!gConfig.agent) gConfig.agent = {}
    gConfig.agent.type = agent as "claude" | "codex" | "gemini"
    globalChanged = true
  }

  const confirmed = await p.confirm({ message: "Save changes?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  if (globalChanged) {
    const globalDir = resolveGlobalConfigDir()
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true })
    writeFileSync(resolveGlobalConfigPath(), yamlStringify(gConfig, { lineWidth: 0 }), "utf-8")
    p.log.success(`Global config updated: ${resolveGlobalConfigPath()}`)
  }

  if (projectChanged) {
    writeFileSync("valley.yaml", yamlStringify(pConfig, { lineWidth: 0 }), "utf-8")
    p.log.success("Project config updated: valley.yaml")
  }

  p.outro(pc.green("Configuration updated!"))
}
