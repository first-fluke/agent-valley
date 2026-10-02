/**
 * Issue creation command — creates a Linear issue via GraphQL API.
 * Uses Claude CLI to expand rough input into a structured issue.
 */

import { spawn } from "node:child_process"
import * as p from "@clack/prompts"
import pc from "picocolors"

const EXPAND_PROMPT = `You are a technical issue writer and complexity analyst. Given a rough idea, produce a structured Linear issue AND analyze its complexity using ISO/IEC 14143 Function Point Analysis.

Output format (no markdown fences, just raw text):
TITLE: type(scope): concise title
DESCRIPTION:
## Goal
One sentence stating the objective.

## Requirements
- Bullet list of concrete requirements (3-5 items)
- Include technical details: endpoints, data structures, error handling
- Be specific but concise

## Notes
- Implementation hints or constraints if relevant

SCORE: <number 1-10>
SCORE_PHASE: <quick or detailed>
SCORE_EI: <count of External Inputs>
SCORE_EO: <count of External Outputs>
SCORE_EQ: <count of External Inquiries>
SCORE_ILF: <count of Internal Logical Files>
SCORE_EIF: <count of External Interface Files>
SCORE_REASONING: <one paragraph explaining the complexity analysis>

Complexity scoring rules:
- Identify the five ISO/IEC 14143 function types from the requirements
- Score from 1 (trivial typo fix) to 10 (complex multi-system integration)
- IMPORTANT: If your initial score is 4-7, perform IFPUG re-analysis per ISO/IEC 20926:
  estimate DET/RET/FTR counts, apply complexity matrix (Low/Average/High), and adjust the score

Issue writing rules:
- Title must use conventional commit format: feat|fix|refactor|chore(scope): description
- Description must be actionable — an AI agent will implement this directly
- Infer reasonable technical details from the rough input
- Write in the same language as the input
- Do NOT wrap in markdown code blocks`

export interface IssueInput {
  title: string
  description: string
  score: number | null
}

export function parseIssueInput(raw: string): IssueInput {
  const newlineIdx = raw.indexOf("\n")
  if (newlineIdx !== -1) {
    return {
      title: raw.slice(0, newlineIdx).trim(),
      description: raw.slice(newlineIdx + 1).trim(),
      score: null,
    }
  }
  return { title: raw.trim(), description: "", score: null }
}

export function parseExpandedIssue(output: string): IssueInput {
  const titleMatch = output.match(/^TITLE:\s*(.+)$/m)

  // Extract description: everything between DESCRIPTION: and SCORE:
  const descStart = output.match(/^DESCRIPTION:\s*\n/m)
  const scoreStart = output.match(/^SCORE:\s*\d+/m)
  let description = ""
  if (descStart) {
    const startIdx = (descStart.index ?? 0) + descStart[0].length
    const endIdx = scoreStart?.index ?? output.length
    description = output.slice(startIdx, endIdx).trim()
  }

  // Parse score
  const scoreMatch = output.match(/^SCORE:\s*(\d+)$/m)
  let score: number | null = null
  if (scoreMatch) {
    const val = Number(scoreMatch[1])
    if (val >= 1 && val <= 10) score = val
  }

  return {
    title: titleMatch?.[1]?.trim() ?? output.slice(0, 80).trim(),
    description,
    score,
  }
}

async function expandWithClaude(rawInput: string): Promise<IssueInput> {
  const args = ["--print", "--no-session-persistence", "-p", `${EXPAND_PROMPT}\n\nInput: ${rawInput}`]
  const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] })

  const { output, exitCode } = await new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
    const chunks: Buffer[] = []
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    proc.on("close", (code) => resolve({ output: Buffer.concat(chunks).toString("utf-8"), exitCode: code ?? 1 }))
    proc.on("error", reject)
  })

  if (exitCode !== 0) {
    throw new Error("Claude CLI failed. Falling back to raw input.")
  }

  return parseExpandedIssue(output)
}

export async function createIssue(
  input: string | undefined,
  options?: { yes?: boolean; raw?: boolean; parent?: string; blockedBy?: string; scope?: string; breakdown?: boolean },
): Promise<void> {
  const autoConfirm = options?.yes ?? false
  const noExpand = options?.raw ?? false
  const { loadConfig } = await import("@agent-valley/core/config/yaml-loader")
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch {
    console.log(pc.red("Setup required. Run `bun av setup` first."))
    process.exit(1)
  }
  const apiKey = config.linearApiKey
  const teamUuid = config.linearTeamUuid

  if (config.trackerKind === "github" && (options?.parent || options?.blockedBy || options?.breakdown)) {
    throw new Error(
      "GitHub issue creation supports --raw, --yes, and --scope. --parent, --blocked-by, and --breakdown currently require tracker.kind: linear in valley.yaml.",
    )
  }

  // --breakdown mode: delegate to breakdown handler
  if (options?.breakdown) {
    if (options.parent || options.blockedBy) {
      throw new Error(
        "--breakdown creates its own parent and dependency graph. Use --parent/--blocked-by when creating individual issues.",
      )
    }
    if (!input) {
      const t = await p.text({ message: "Describe the feature to break down", placeholder: "Build auth system" })
      if (p.isCancel(t)) {
        p.cancel("Cancelled")
        process.exit(0)
      }
      input = t
    }
    const { executeBreakdown } = await import("./breakdown")
    await executeBreakdown(input, { yes: autoConfirm, scope: options.scope })
    return
  }

  let title: string
  let description: string
  let score: number | null = null

  if (!input) {
    // Interactive mode
    p.intro(pc.bgMagenta(pc.black(" New Issue ")))

    const t = await p.text({
      message: "What do you want to build?",
      placeholder: "Add login feature",
      validate: (v) => {
        if (!v) return "Required"
      },
    })
    if (p.isCancel(t)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    input = t
  }

  const s = p.spinner()

  if (noExpand) {
    const parsed = parseIssueInput(input)
    title = parsed.title || input
    description = parsed.description
  } else {
    // Expand with Claude
    s.start("Expanding issue...")

    try {
      const expanded = await expandWithClaude(input)
      title = expanded.title
      description = expanded.description
      score = expanded.score
      s.stop("Issue expansion complete")
    } catch {
      // Fallback: use raw input as-is
      s.stop(pc.yellow("Claude CLI unavailable — using raw input"))
      const parsed = parseIssueInput(input)
      title = parsed.title || input
      description = parsed.description
    }
  }

  if (!title.trim()) throw new Error("Issue title is empty. Pass a description or enter a non-empty title.")

  // Resolve --parent identifier to UUID
  let parentId: string | null = null
  if (options?.parent) {
    s.start(`Resolving parent issue (${options.parent})...`)
    try {
      const { fetchIssueByIdentifier } = await import("@agent-valley/core/tracker/linear-client")
      const found = await fetchIssueByIdentifier(apiKey, teamUuid, options.parent)
      if (!found || found.identifier !== options.parent)
        throw new Error(`Issue not found in the configured team: ${options.parent}`)
      parentId = found.id
      s.stop(pc.green(`Parent issue: ${found.identifier}`))
    } catch (e) {
      s.stop(pc.red("Failed to resolve parent issue"))
      console.log(pc.red((e as Error).message))
      process.exit(1)
    }
  }

  // Show preview and confirm
  const scoreDisplay = score !== null ? `\n${pc.cyan(`Complexity: score:${score}`)}` : ""
  const scopeDisplay = options?.scope ? `\n${pc.blue(`Scope: scope:${options.scope.replace(/^scope:/, "")}`)}` : ""
  const parentDisplay = parentId ? `\n${pc.magenta(`Parent: ${options?.parent}`)}` : ""
  const blockerDisplay = options?.blockedBy ? `\n${pc.yellow(`blocked by: ${options.blockedBy}`)}` : ""
  p.note(
    [
      `${pc.bold(title)}`,
      "",
      description || pc.dim("(no description)"),
      scoreDisplay,
      scopeDisplay,
      parentDisplay,
      blockerDisplay,
    ].join("\n"),
    "Issue Preview",
  )

  if (!autoConfirm) {
    const confirmed = await p.confirm({ message: "Create this issue?" })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled")
      process.exit(0)
    }
  }

  if (config.trackerKind === "github") {
    if (!config.github) throw new Error("Set github configuration in valley.yaml before creating an issue.")
    s.start("Creating GitHub issue...")
    try {
      const { createGithubIssue } = await import("./github-issue")
      const issue = await createGithubIssue(config.github, { title, description, scope: options?.scope, score })
      s.stop(pc.green(`Issue created: ${issue.identifier}`))
      p.note(
        `${pc.bold(issue.identifier)}: ${issue.title}\n\n${issue.url}\n\nLabel: ${config.github.labels.todo} — the running server receives this issue through its GitHub webhook.`,
        "Created",
      )
    } catch (error) {
      s.stop(pc.red("Failed to create GitHub issue"))
      throw error
    }
    return
  }

  // Create in Linear
  s.start("Creating Linear issue...")

  try {
    const { createLinearIssue } = await import("./linear-issue")
    const issue = await createLinearIssue(config, {
      title,
      description,
      parentId,
      scope: options?.scope,
      score,
      blockedBy: options?.blockedBy,
    })

    s.stop(pc.green(`Issue created: ${issue.identifier}`))

    const infoLines = [`${pc.bold(issue.identifier)}: ${issue.title}`, "", pc.dim(issue.url), ""]
    if (parentId) infoLines.push(`${pc.magenta("Sub-issue of")} ${options?.parent}`)
    if (options?.blockedBy) infoLines.push(`${pc.yellow("Blocked by")} ${options.blockedBy}`)
    infoLines.push(`Status: ${pc.green("Todo")} — agent will start automatically if the server is running`)

    p.note(infoLines.join("\n"), "Created")
  } catch (e) {
    s.stop(pc.red("Failed to create issue"))
    console.log(pc.red((e as Error).message))
    process.exit(1)
  }
}
