/**
 * Breakdown — Auto-decompose an issue into sub-issues with dependency DAG.
 * Uses Claude CLI to analyze and split a large issue into smaller tasks.
 */

import { spawn } from "node:child_process"
import { loadConfig } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { publishBreakdown, validateBreakdown } from "./breakdown-publish"

const BREAKDOWN_PROMPT = `You are a technical project decomposer. Given a feature description, break it down into concrete sub-issues with dependency relationships.

Output format (no markdown fences, just raw text):

PARENT_TITLE: type(scope): concise parent title
PARENT_DESCRIPTION:
## Goal
One sentence stating the overall objective.

SUB_ISSUES:
---
TITLE: type(scope): sub-issue title
DESCRIPTION: One-line description of this sub-task
BLOCKED_BY: (comma-separated indices of other sub-issues this depends on, or empty)
---
TITLE: type(scope): another sub-issue title
DESCRIPTION: One-line description
BLOCKED_BY: 1
---

Rules:
- Each sub-issue title must use conventional commit format: feat|fix|refactor|chore(scope): description
- Use 1-based indices for BLOCKED_BY references (e.g., "1" means blocked by the first sub-issue)
- Only add BLOCKED_BY when there is a genuine technical dependency
- Aim for 2-6 sub-issues (not too granular, not too coarse)
- Write in the same language as the input
- Sub-issues should be independently testable and assignable to an AI agent`

export interface BreakdownSubIssue {
  title: string
  description: string
  blockedByIndices: number[]
}

export interface BreakdownResult {
  parentTitle: string
  parentDescription: string
  subIssues: BreakdownSubIssue[]
}

export function parseBreakdownOutput(output: string): BreakdownResult {
  const parentTitleMatch = output.match(/^PARENT_TITLE:\s*(.+)$/m)
  const parentDescStart = output.match(/^PARENT_DESCRIPTION:\s*\n/m)
  const subIssuesStart = output.match(/^SUB_ISSUES:\s*\n/m)

  let parentDescription = ""
  if (parentDescStart && subIssuesStart) {
    const start = (parentDescStart.index ?? 0) + parentDescStart[0].length
    const end = subIssuesStart.index ?? output.length
    parentDescription = output.slice(start, end).trim()
  }

  const subIssues: BreakdownSubIssue[] = []
  const subSection = subIssuesStart ? output.slice((subIssuesStart.index ?? 0) + subIssuesStart[0].length) : ""
  const blocks = subSection.split(/^---$/m).filter((b) => b.trim())

  for (const block of blocks) {
    const titleMatch = block.match(/^TITLE:\s*(.+)$/m)
    const descMatch = block.match(/^DESCRIPTION:\s*(.+)$/m)
    const blockedMatch = block.match(/^BLOCKED_BY:\s*(.*)$/m)

    if (titleMatch) {
      const blockedByStr = blockedMatch?.[1]?.trim() ?? ""
      const blockedByIndices = blockedByStr ? blockedByStr.split(",").map((s) => Number(s.trim())) : []

      subIssues.push({
        title: titleMatch[1]?.trim() ?? "",
        description: descMatch?.[1]?.trim() ?? "",
        blockedByIndices,
      })
    }
  }

  return {
    parentTitle: parentTitleMatch?.[1]?.trim() ?? "Untitled",
    parentDescription,
    subIssues,
  }
}

export function renderDagPreview(result: BreakdownResult): string {
  const lines: string[] = [
    pc.bold(result.parentTitle),
    result.parentDescription ? pc.dim(result.parentDescription.slice(0, 120)) : "",
    "",
  ]

  for (let i = 0; i < result.subIssues.length; i++) {
    const sub = result.subIssues[i]
    if (!sub) continue
    const isLast = i === result.subIssues.length - 1
    const prefix = isLast ? "└── " : "├── "
    const blockedStr =
      sub.blockedByIndices.length > 0 ? pc.yellow(` (blocked by: ${sub.blockedByIndices.join(", ")})`) : ""
    lines.push(`${prefix}${pc.cyan(`${i + 1}.`)} ${sub.title}${blockedStr}`)
  }

  return lines.join("\n")
}

async function expandBreakdownWithClaude(rawInput: string): Promise<BreakdownResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["--print", "--no-session-persistence", "-p", `${BREAKDOWN_PROMPT}\n\nInput: ${rawInput}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const chunks: Buffer[] = []
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error("Claude CLI failed during breakdown analysis."))
      else resolve(Buffer.concat(chunks).toString("utf-8"))
    })
    proc.on("error", reject)
  })

  if (!output) {
    throw new Error("Claude CLI failed during breakdown analysis.")
  }

  return parseBreakdownOutput(output)
}

export async function executeBreakdown(input: string, opts: { yes?: boolean; scope?: string }): Promise<void> {
  const config = loadConfig()
  if (config.trackerKind !== "linear")
    throw new Error("Issue breakdown currently requires tracker.kind: linear in av.yaml.")

  p.intro(pc.bgMagenta(pc.black(" Issue Breakdown ")))
  const s = p.spinner()

  // Step 1: Claude decomposes the issue
  s.start("Decomposing issue...")
  let result: BreakdownResult
  try {
    result = await expandBreakdownWithClaude(input)
    s.stop("Issue decomposition complete")
  } catch (e) {
    s.stop(pc.red("Decomposition failed"))
    console.log(pc.red((e as Error).message))
    process.exit(1)
  }

  if (result.subIssues.length === 0) {
    console.log(pc.yellow("No sub-issues to create."))
    process.exit(0)
  }

  validateBreakdown(result)

  // Step 2: Preview
  p.note(renderDagPreview(result), "Breakdown Result")

  if (!opts.yes) {
    const confirmed = await p.confirm({ message: `Create ${result.subIssues.length} sub-issues?` })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled")
      process.exit(0)
    }
  }

  s.start("Preparing issues and dependencies in Backlog...")
  let published: Awaited<ReturnType<typeof publishBreakdown>>
  try {
    published = await publishBreakdown(config, result, opts.scope)
    s.stop(pc.green(`Published ${published.children.length} sub-issues with dependencies`))
  } catch (error) {
    s.stop(pc.red("Breakdown could not be published"))
    throw error
  }
  const { parent: parentIssue, children: createdIds, relationsCreated } = published

  // Step 6: Summary
  const summaryLines = [
    `${pc.bold(parentIssue.identifier)}: ${parentIssue.title}`,
    pc.dim(parentIssue.url),
    "",
    `Sub-issues: ${pc.green(String(createdIds.length))}`,
    `Dependencies: ${pc.yellow(String(relationsCreated))}`,
    "",
  ]
  for (const created of createdIds) {
    const sub = result.subIssues[created.index - 1]
    if (!sub) continue
    const blockedStr =
      sub.blockedByIndices.length > 0
        ? pc.dim(
            ` ← blocked by ${sub.blockedByIndices.map((i) => createdIds.find((c) => c.index === i)?.identifier ?? `#${i}`).join(", ")}`,
          )
        : ""
    summaryLines.push(`  ${created.identifier}: ${sub.title}${blockedStr}`)
  }

  p.note(summaryLines.join("\n"), "Breakdown Complete")
}
