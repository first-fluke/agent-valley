/**
 * Scoring Service — ISO/IEC 14143 function point analysis via LLM.
 * Application layer: calls LLM, returns ScoreAnalysis. No Linear API calls.
 */

import type { Issue, ScoreAnalysis } from "../domain/models"
import { sanitizeIssueBody } from "../config/workflow-loader"
import { logger } from "../observability/logger"

export interface ScoringService {
  analyze(title: string, description: string): Promise<ScoreAnalysis>
}

// ── Prompts ────────────────────────────────────────────────────────

const QUICK_SCORING_PROMPT = `You are a software complexity analyst. Analyze the following issue using ISO/IEC 14143 Function Point Analysis.

Identify the five function types:
- EI (External Input): data entering the system
- EO (External Output): data leaving the system
- EQ (External Inquiry): input+output queries
- ILF (Internal Logical File): internally maintained data groups
- EIF (External Interface File): externally referenced data

Score the issue complexity from 1 (trivial) to 10 (very complex) based on:
- Number and complexity of function types identified
- Data element types (DET) and record/file types involved
- Integration points and external dependencies

IMPORTANT: If your initial score falls between 4 and 7 (inclusive), you MUST perform a detailed IFPUG re-analysis per ISO/IEC 20926:
- Estimate DET count per function type
- Estimate RET (record element types) for ILF/EIF
- Estimate FTR (file types referenced) for EI/EO/EQ
- Re-weight using IFPUG complexity matrix (Low/Average/High)
- Adjust the final score accordingly

Output EXACTLY in this format (no markdown, no extra text):
SCORE: <number 1-10>
PHASE: <quick or detailed>
EI: <count>
EO: <count>
EQ: <count>
ILF: <count>
EIF: <count>
REASONING: <one paragraph explaining the analysis>`

// ── LLM Scoring Service ────────────────────────────────────────────

export class LlmScoringService implements ScoringService {
  constructor(private readonly model: string) {}

  async analyze(title: string, description: string): Promise<ScoreAnalysis> {
    const safeTitle = sanitizeIssueBody(title)
    const safeDescription = sanitizeIssueBody(description)
    const input = `Issue Title: ${safeTitle}\n\nIssue Description:\n${safeDescription || "(no description)"}`
    const prompt = `${QUICK_SCORING_PROMPT}\n\n${input}`

    const output = await this.callLlm(prompt)
    return parseScoringOutput(output)
  }

  private async callLlm(prompt: string): Promise<string> {
    const modelFlag = this.model !== "claude" ? ["--model", this.model] : []
    const proc = Bun.spawn(
      ["claude", "--print", "--no-session-persistence", ...modelFlag, "-p", prompt],
      { stdout: "pipe", stderr: "pipe" },
    )

    const output = await new Response(proc.stdout).text()
    await proc.exited

    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`Scoring LLM call failed (exit ${proc.exitCode}): ${stderr.slice(0, 200)}`)
    }

    return output.trim()
  }
}

// ── Output Parser ──────────────────────────────────────────────────

function parseScoringOutput(output: string): ScoreAnalysis {
  const rawScore = parseField(output, "SCORE", -1)
  const score = rawScore === -1 ? 5 : rawScore
  if (rawScore === -1) {
    logger.warn("scoring-service", "SCORE field missing from LLM output, defaulting to 5")
  }
  const phase = output.match(/^PHASE:\s*(quick|detailed)$/m)?.[1] as "quick" | "detailed" | undefined
  const ei = parseField(output, "EI", 0)
  const eo = parseField(output, "EO", 0)
  const eq = parseField(output, "EQ", 0)
  const ilf = parseField(output, "ILF", 0)
  const eif = parseField(output, "EIF", 0)
  const reasoning = output.match(/^REASONING:\s*(.+)$/m)?.[1]?.trim() ?? "No reasoning provided"

  const clampedScore = Math.max(1, Math.min(10, score))

  if (clampedScore !== score) {
    logger.warn("scoring-service", `Score ${score} out of range, clamped to ${clampedScore}`)
  }

  return {
    score: clampedScore,
    phase: phase ?? "quick",
    functionTypes: { ei, eo, eq, ilf, eif },
    reasoning,
  }
}

function parseField(output: string, field: string, fallback: number): number {
  const match = output.match(new RegExp(`^${field}:\\s*(\\d+)`, "m"))
  return match ? Number(match[1]) : fallback
}

// ── Background Scoring ─────────────────────────────────────────────

/**
 * Fire-and-forget scoring: analyze issue in background, then call onScore callback.
 * The current run uses defaultAgentType; the score label takes effect on subsequent runs.
 * Uses callback to avoid direct Infrastructure import (layer boundary).
 */
export function analyzeScoreInBackground(
  issue: Issue,
  scoringModel: string,
  onScore: (issueId: string, score: number) => Promise<void>,
): void {
  const scorer = new LlmScoringService(scoringModel)

  scorer.analyze(issue.title, issue.description)
    .then(async (analysis) => {
      logger.info("scoring-service", `Score analysis for ${issue.identifier}: ${analysis.score} (${analysis.phase})`, {
        reasoning: analysis.reasoning,
      })
      await onScore(issue.id, analysis.score)
    })
    .catch((err) => {
      logger.warn("scoring-service", `Background scoring failed for ${issue.identifier}`, {
        error: String(err),
      })
    })
}
