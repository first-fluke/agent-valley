/**
 * Workflow Router — maps an incoming issue's title/description to the oma
 * workflow(s)/skill(s) it matches, using `.agents/hooks/core/triggers.json`
 * as the keyword table.
 *
 * WHY THIS EXISTS: oma's own `UserPromptSubmit` hook (which normally does
 * this same keyword -> workflow routing for interactive sessions) does not
 * reliably fire when an agent CLI is invoked non-interactively via
 * `--print` (confirmed empirically — see team-lead handoff). Symphony's
 * Orchestrator is the only thing that reliably sees the issue text before
 * the agent process starts, so routing has to happen here instead and be
 * injected directly into the rendered prompt (see `workflow-loader.ts`).
 *
 * FAIL-SOFT BY DESIGN: most target repos this harness runs against will not
 * ship `.agents/hooks/core/triggers.json` at all (oma is optional tooling).
 * A missing or malformed table must never throw — it just means "no
 * routing today", identical to today's behavior before this module existed.
 *
 * MATCHING SEMANTICS (mirrors `.agents/hooks/core/keyword-detector.ts`,
 * the reference implementation used by oma's own hook):
 *   - Text and keywords are both normalized with NFKC + lowercase before
 *     comparison (folds fullwidth CJK-IME Latin characters, casefolds).
 *   - ASCII keywords are matched with a word-boundary regex so a short
 *     token like the `work` workflow keyword does not fire on `framework`
 *     or `workspace_path` — mirrors keyword-detector's `buildPatternEntries`
 *     boundary wrapping for non-CJK keywords.
 *   - Non-ASCII (CJK, accented, etc.) keywords are matched as a raw
 *     substring, un-boundaried — mirrors keyword-detector's CJK branch,
 *     since CJK scripts have no whitespace word boundaries to lean on.
 *   - Keywords from EVERY language list in triggers.json are scanned
 *     (`*`, en, ko, ja, zh, ...), not just one configured language: an
 *     issue can be filed in any language regardless of the project's
 *     configured RESPONSE language (`oma-config.yaml` `language` governs
 *     reply language, not input language) — mirrors keyword-detector's own
 *     RC4 rationale for `informationalPatterns`, generalized here to every
 *     keyword bank since routing has no equivalent to a fixed UI language.
 *   - `informationalPatterns` suppress a keyword match found within a
 *     60-char window of an informational/question phrase ("what is",
 *     "explain", ...), mirroring `isInformationalContext`.
 *   - A persistent workflow (orchestrate/ultrawork/work/ralph) is skipped
 *     entirely when the issue text reads as an analytical question (first
 *     line ends in "?" and contains an interrogative/informational cue),
 *     mirroring the `analytical && def.persistent` skip.
 *   - `excludedWorkflows` are never routed, matching keyword-detector.
 *
 * DIVERGENCE FROM keyword-detector.ts (documented, intentional):
 *   - No reinforcement-loop suppression, no pasted-content position guard,
 *     no CLI-invocation-prefix guard, no specificity ranking between
 *     competing workflows. Those all exist in keyword-detector.ts to tame a
 *     *live conversational* prompt stream; an issue body is a single,
 *     static piece of text submitted once, so those guards have no
 *     equivalent failure mode here. Multiple workflows/skills may route
 *     simultaneously (returned as a list) rather than picking one winner —
 *     an issue is allowed to need more than one workflow's guidance.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface WorkflowKeywordDef {
  persistent: boolean
  keywords: Record<string, string[]>
}

export interface SkillKeywordDef {
  keywords: Record<string, string[]>
}

export interface TriggerTable {
  workflows: Record<string, WorkflowKeywordDef>
  skills: Record<string, SkillKeywordDef>
  informationalPatterns: Record<string, string[]>
  excludedWorkflows: string[]
}

export interface RouteResult {
  workflows: string[]
  skills: string[]
}

const INFORMATIONAL_WINDOW = 60

// ── Normalization (mirrors keyword-detector.ts normalizeForMatching) ──

/**
 * Normalize text for matching: NFKC folds fullwidth Latin (CJK IME input)
 * to ASCII equivalents, then lowercase. Whitespace is additionally
 * collapsed to single spaces so a multi-word keyword still matches text
 * containing newlines/tabs/repeated spaces (issue descriptions are
 * frequently multi-line, unlike a single-line chat prompt).
 */
export function normalizeForRouting(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Build a global, case-insensitive regex for one keyword. ASCII keywords
 * get word-boundary guards (see module doc); non-ASCII keywords do not,
 * matching keyword-detector's CJK branch.
 */
function buildKeywordRegex(keyword: string): RegExp | null {
  const normalized = normalizeForRouting(keyword)
  if (!normalized) return null
  const escaped = escapeRegex(normalized).replace(/\s+/g, "\\s+")
  // charCodeAt check (not a \x00-\x7F regex range) avoids matching literal
  // control characters in the pattern itself, which biome's
  // noControlCharactersInRegex rule flags.
  const isAsciiOnly = [...normalized].every((ch) => ch.charCodeAt(0) <= 127)
  const pattern = isAsciiOnly ? `(?:^|[^\\w-])${escaped}(?:$|[^\\w-])` : escaped
  return new RegExp(pattern, "gi")
}

/** Flatten + dedup every language list in a keyword bank into one array. */
function collectAllLangKeywords(bank: Record<string, string[]> | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const arr of Object.values(bank ?? {})) {
    for (const kw of arr) {
      const normalized = normalizeForRouting(kw)
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized)
        result.push(kw)
      }
    }
  }
  return result
}

// ── Informational-context suppression ─────────────────────────────────

function findInformationalWindows(text: string, patternBank: Record<string, string[]>): Array<[number, number]> {
  const windows: Array<[number, number]> = []
  for (const phrase of collectAllLangKeywords(patternBank)) {
    const regex = buildKeywordRegex(phrase)
    if (!regex) continue
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((match = regex.exec(text)) !== null) {
      windows.push([
        Math.max(0, match.index - INFORMATIONAL_WINDOW),
        match.index + match[0].length + INFORMATIONAL_WINDOW,
      ])
      if (match.index === regex.lastIndex) regex.lastIndex++
    }
  }
  return windows
}

const INTERROGATIVE_WORDS = /^(?:why|what|how|when|where|which|who|왜|어떻게|무엇|뭐|어디|언제|누가)/i

/**
 * True when the issue reads as a pure question rather than a work request —
 * mirrors keyword-detector's `isAnalyticalQuestion` gate, which only
 * suppresses PERSISTENT workflows (orchestrate/ultrawork/work/ralph).
 */
function isAnalyticalIssue(text: string, infoPatterns: string[]): boolean {
  const firstLine = (text.split("\n")[0] ?? "").trim()
  if (!firstLine.endsWith("?")) return false
  return INTERROGATIVE_WORDS.test(firstLine) || infoPatterns.some((p) => firstLine.includes(p))
}

function hasUnsuppressedMatch(
  text: string,
  bank: Record<string, string[]>,
  infoWindows: Array<[number, number]>,
): boolean {
  for (const keyword of collectAllLangKeywords(bank)) {
    const regex = buildKeywordRegex(keyword)
    if (!regex) continue
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((match = regex.exec(text)) !== null) {
      const suppressed = infoWindows.some(([start, end]) => match !== null && match.index >= start && match.index < end)
      if (!suppressed) return true
      if (match.index === regex.lastIndex) regex.lastIndex++
    }
  }
  return false
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Route issue text (title + description, or any combined string) against
 * an already-loaded trigger table. Pure and dependency-free — the primary
 * entry point for testing; production code normally goes through
 * `routeIssueWithDefaultTable` instead.
 */
export function routeIssue(text: string, table: TriggerTable): RouteResult {
  const normalized = normalizeForRouting(text)
  if (!normalized) return { workflows: [], skills: [] }

  const infoPatternList = collectAllLangKeywords(table.informationalPatterns)
  const infoWindows = findInformationalWindows(normalized, table.informationalPatterns ?? {})
  const analytical = isAnalyticalIssue(normalized, infoPatternList)
  const excluded = new Set(table.excludedWorkflows ?? [])

  const workflows: string[] = []
  for (const [name, def] of Object.entries(table.workflows ?? {})) {
    if (excluded.has(name)) continue
    if (def.persistent && analytical) continue
    if (hasUnsuppressedMatch(normalized, def.keywords, infoWindows)) {
      workflows.push(name)
    }
  }

  const skills: string[] = []
  for (const [name, def] of Object.entries(table.skills ?? {})) {
    if (hasUnsuppressedMatch(normalized, def.keywords, infoWindows)) {
      skills.push(name)
    }
  }

  return { workflows, skills }
}

// ── Trigger table loading (fail-soft, cached) ──────────────────────────

function isTriggerTableShape(value: unknown): value is TriggerTable {
  return (
    typeof value === "object" &&
    value !== null &&
    "workflows" in value &&
    typeof (value as Record<string, unknown>).workflows === "object"
  )
}

/**
 * Load `.agents/hooks/core/triggers.json` from `rootDir`. Returns `null`
 * (never throws) when the file is absent or malformed — absence is the
 * expected case for any target repo that doesn't ship oma.
 */
export function loadTriggerTable(rootDir: string): TriggerTable | null {
  const path = join(rootDir, ".agents", "hooks", "core", "triggers.json")
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
    return isTriggerTableShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

const triggerTableCache = new Map<string, TriggerTable | null>()

/**
 * Cached variant of `loadTriggerTable`, keyed by `rootDir`. Defaults to
 * `process.cwd()`, matching the `projectRoot ?? process.cwd()` convention
 * used by `yaml-loader.ts` elsewhere in this package.
 */
export function getCachedTriggerTable(rootDir: string = process.cwd()): TriggerTable | null {
  if (!triggerTableCache.has(rootDir)) {
    triggerTableCache.set(rootDir, loadTriggerTable(rootDir))
  }
  return triggerTableCache.get(rootDir) ?? null
}

/** Test-only escape hatch — clears the module-level cache between test cases. */
export function resetTriggerTableCache(): void {
  triggerTableCache.clear()
}

/** Convenience: load (cached) + route in one call. */
export function routeIssueWithDefaultTable(text: string, rootDir: string = process.cwd()): RouteResult {
  const table = getCachedTriggerTable(rootDir)
  if (!table) return { workflows: [], skills: [] }
  return routeIssue(text, table)
}
