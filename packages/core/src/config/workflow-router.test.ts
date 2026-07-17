/**
 * Workflow Router tests — issue-text -> oma workflow/skill routing.
 * Unit tests use an injected TriggerTable (never depend on the real
 * .agents/hooks/core/triggers.json), except the final integration test.
 */
import { join } from "node:path"
import { beforeEach, describe, expect, test } from "vitest"
import {
  getCachedTriggerTable,
  loadTriggerTable,
  normalizeForRouting,
  resetTriggerTableCache,
  routeIssue,
  routeIssueWithDefaultTable,
  type TriggerTable,
} from "./workflow-router.ts"

// ── Injected fixture table ─────────────────────────────────────────────

function makeTable(overrides: Partial<TriggerTable> = {}): TriggerTable {
  return {
    workflows: {
      debug: {
        persistent: false,
        keywords: {
          "*": ["debug"],
          en: ["fix bug", "fix the bug", "doesn't work"],
          ko: ["버그 고쳐줘", "고쳐줘"],
        },
      },
      plan: {
        persistent: false,
        keywords: {
          "*": [],
          en: ["plan", "break down"],
        },
      },
      review: {
        persistent: false,
        keywords: {
          "*": ["code review"],
          en: ["audit"],
        },
      },
      design: {
        persistent: false,
        keywords: {
          "*": [],
          en: ["theme"],
          ko: ["디자인"],
        },
      },
      orchestrate: {
        persistent: true,
        keywords: {
          "*": ["orchestrate"],
          en: ["parallel"],
        },
      },
      work: {
        persistent: true,
        keywords: {
          "*": ["work"],
        },
      },
      tools: {
        persistent: false,
        keywords: { "*": ["tools"] },
      },
    },
    skills: {
      "oma-backend": {
        keywords: {
          "*": ["backend service", "auth flow"],
          en: ["rest api"],
        },
      },
      "oma-frontend": {
        keywords: {
          "*": ["frontend"],
        },
      },
    },
    informationalPatterns: {
      "*": ["what is", "explain"],
      ko: ["뭐야", "설명해"],
    },
    excludedWorkflows: ["tools"],
    ...overrides,
  }
}

// ── normalizeForRouting ─────────────────────────────────────────────────

describe("normalizeForRouting", () => {
  test("lowercases and NFKC-normalizes fullwidth Latin", () => {
    expect(normalizeForRouting("ＤＥＢＵＧ")).toBe("debug")
  })

  test("collapses whitespace runs (issue bodies are multi-line)", () => {
    expect(normalizeForRouting("fix   the\n\nbug")).toBe("fix the bug")
  })
})

// ── routeIssue: basic matching ───────────────────────────────────────────

describe("routeIssue", () => {
  test("matches a debug workflow and oma-backend skill from a mixed request", () => {
    const table = makeTable()
    const result = routeIssue("Debug the backend service auth flow bug urgently", table)
    expect(result.workflows).toContain("debug")
    expect(result.skills).toContain("oma-backend")
  })

  test("routes a Korean debug issue via ko keywords", () => {
    const table = makeTable()
    const result = routeIssue("결제 버그 고쳐줘", table)
    expect(result.workflows).toContain("debug")
  })

  test("CJK keywords match without word-boundary guards", () => {
    const table = makeTable()
    const result = routeIssue("이 페이지 디자인 좀 해줘", table)
    expect(result.workflows).toContain("design")
  })

  test("returns empty result for text with no matches", () => {
    const table = makeTable()
    const result = routeIssue("Update the changelog for the release", table)
    expect(result.workflows).toEqual([])
    expect(result.skills).toEqual([])
  })

  test("empty issue text routes nothing", () => {
    const table = makeTable()
    const result = routeIssue("   ", table)
    expect(result).toEqual({ workflows: [], skills: [] })
  })
})

// ── Persistent workflows are excluded unconditionally ─────────────────

describe("routeIssue persistent workflow exclusion", () => {
  test("'doesn't work' routes to debug but never to the persistent 'work' workflow", () => {
    const table = makeTable()
    const result = routeIssue("This feature doesn't work in production, please fix", table)
    expect(result.workflows).toContain("debug")
    expect(result.workflows).not.toContain("work")
  })

  test("bare 'work' keyword never routes, even standalone", () => {
    const table = makeTable()
    const result = routeIssue("Please work on this as soon as possible", table)
    expect(result.workflows).not.toContain("work")
  })

  test("a genuine, non-question orchestrate-shaped request still never routes to persistent orchestrate", () => {
    const table = makeTable()
    const result = routeIssue("Please orchestrate the release across all three services in parallel", table)
    expect(result.workflows).not.toContain("orchestrate")
  })

  test("persistent workflows are excluded regardless of question phrasing", () => {
    const table = makeTable()
    const result = routeIssue("What is the orchestrate workflow and how does it work?", table)
    expect(result.workflows).not.toContain("orchestrate")
    expect(result.workflows).not.toContain("work")
  })
})

// ── excludedWorkflows ─────────────────────────────────────────────────

describe("routeIssue excludedWorkflows", () => {
  test("an excluded workflow never routes even when its keyword matches", () => {
    const table = makeTable()
    const result = routeIssue("Please check the tools for this task", table)
    expect(result.workflows).not.toContain("tools")
  })
})

// ── Weak short-ASCII-keyword guard (workflows only) ────────────────────

describe("routeIssue weak keyword guard", () => {
  test("bare 'plan' buried mid-sentence does not trigger the plan workflow alone", () => {
    const table = makeTable()
    const result = routeIssue("We plan to ship this next week once QA signs off", table)
    expect(result.workflows).not.toContain("plan")
  })

  test("bare 'theme' buried mid-sentence does not trigger the design workflow alone", () => {
    const table = makeTable()
    const result = routeIssue("The theme of this issue is user retention, not visuals", table)
    expect(result.workflows).not.toContain("design")
  })

  test("bare 'audit' buried mid-sentence does not trigger the review workflow alone", () => {
    const table = makeTable()
    const result = routeIssue("Let's audit the results next quarter after launch", table)
    expect(result.workflows).not.toContain("review")
  })

  test("sentence-initial (imperative) 'plan' still triggers the plan workflow", () => {
    const table = makeTable()
    const result = routeIssue("Plan the Q3 roadmap for the team", table)
    expect(result.workflows).toContain("plan")
  })

  test("slash-command form '/plan' still triggers the plan workflow", () => {
    const table = makeTable()
    const result = routeIssue("/plan the migration to the new billing system", table)
    expect(result.workflows).toContain("plan")
  })

  test("a weak match corroborated by a second distinct keyword still triggers", () => {
    const table = makeTable()
    // "plan" alone (mid-sentence) would be dropped, but "break down" is a
    // second, independent keyword match for the same workflow.
    const result = routeIssue("We should plan this properly and break down the requirements", table)
    expect(result.workflows).toContain("plan")
  })

  test("two distinct weak keywords together still corroborate each other", () => {
    const table = makeTable({
      workflows: {
        misc: {
          persistent: false,
          keywords: { en: ["abcd", "wxyz"] },
        },
      },
    })
    const result = routeIssue("Random text mentions abcd once and wxyz once, nothing else", table)
    expect(result.workflows).toContain("misc")
  })

  test("a single weak keyword occurrence with no imperative position and no corroboration is dropped", () => {
    const table = makeTable({
      workflows: {
        misc: {
          persistent: false,
          keywords: { en: ["abcd"] },
        },
      },
    })
    const result = routeIssue("Random text mentions abcd once, buried in the middle, nothing else", table)
    expect(result.workflows).not.toContain("misc")
  })

  test("multi-word phrases are never weak, regardless of total length", () => {
    const table = makeTable()
    const result = routeIssue("Please run a code review before merging", table)
    expect(result.workflows).toContain("review")
  })

  test("skills are unaffected by the weak-keyword guard (stay high-recall)", () => {
    const table = makeTable({
      skills: {
        "oma-search": { keywords: { en: ["find"] } },
      },
    })
    const result = routeIssue("Can you find the library docs for this, buried mid sentence", table)
    expect(result.skills).toContain("oma-search")
  })
})

// ── informationalPatterns suppression ────────────────────────────────

describe("routeIssue informationalPatterns", () => {
  test("an informational question about a non-persistent workflow suppresses that match", () => {
    const table = makeTable()
    const result = routeIssue("What is a code review and how does it work here?", table)
    expect(result.workflows).not.toContain("review")
  })

  test("a genuine (non-question) request still triggers a non-persistent workflow", () => {
    const table = makeTable()
    const result = routeIssue("Please run a code review on this PR before merging", table)
    expect(result.workflows).toContain("review")
  })
})

// ── loadTriggerTable / getCachedTriggerTable (fail-soft) ─────────────

describe("loadTriggerTable", () => {
  test("returns null for a directory with no triggers.json", () => {
    expect(loadTriggerTable("/nonexistent/path/that/does/not/exist")).toBeNull()
  })
})

describe("getCachedTriggerTable", () => {
  beforeEach(() => {
    resetTriggerTableCache()
  })

  test("caches null for a missing table without re-reading", () => {
    const dir = "/nonexistent/path/that/does/not/exist"
    expect(getCachedTriggerTable(dir)).toBeNull()
    expect(getCachedTriggerTable(dir)).toBeNull()
  })
})

describe("routeIssueWithDefaultTable", () => {
  beforeEach(() => {
    resetTriggerTableCache()
  })

  test("returns empty routing when no table is found at rootDir", () => {
    const result = routeIssueWithDefaultTable("debug this bug", "/nonexistent/path/that/does/not/exist")
    expect(result).toEqual({ workflows: [], skills: [] })
  })
})

// ── Integration: real .agents/hooks/core/triggers.json ────────────────

describe("integration: real triggers.json", () => {
  beforeEach(() => {
    resetTriggerTableCache()
  })

  const projectRoot = join(import.meta.dirname, "..", "..", "..", "..")

  test("real triggers.json parses and loads", () => {
    const table = loadTriggerTable(projectRoot)
    expect(table).not.toBeNull()
    expect(table?.workflows.debug).toBeDefined()
    expect(table?.skills["oma-backend"]).toBeDefined()
    // informationalPatterns is a dict keyed by language (Record<string,
    // string[]>), NOT a flat array — confirmed against the real file.
    expect(Array.isArray(table?.informationalPatterns)).toBe(false)
    expect(Array.isArray(table?.informationalPatterns["*"])).toBe(true)
  })

  test("real triggers.json routes a debug+backend sample issue", () => {
    const table = loadTriggerTable(projectRoot)
    expect(table).not.toBeNull()
    if (!table) throw new Error("expected table to load")
    const result = routeIssue("Debug the backend service auth flow — users can't log in", table)
    expect(result.workflows).toContain("debug")
    expect(result.skills).toContain("oma-backend")
  })

  test("real triggers.json never routes any persistent workflow", () => {
    const table = loadTriggerTable(projectRoot)
    expect(table).not.toBeNull()
    if (!table) throw new Error("expected table to load")
    const persistentNames = Object.entries(table.workflows)
      .filter(([, def]) => def.persistent)
      .map(([name]) => name)
    expect(persistentNames.length).toBeGreaterThan(0) // sanity: fixture assumption still holds

    const samples = [
      "This feature doesn't work in production, please fix it",
      "We should plan this and work through the requirements together",
      "Please orchestrate the deployment across every service in parallel",
      "Let's run this step by step, one by one, guide me through it",
    ]
    for (const sample of samples) {
      const result = routeIssue(sample, table)
      for (const persistentName of persistentNames) {
        expect(result.workflows).not.toContain(persistentName)
      }
    }
  })

  test("real triggers.json: common short-word false positives from prose are suppressed", () => {
    const table = loadTriggerTable(projectRoot)
    expect(table).not.toBeNull()
    if (!table) throw new Error("expected table to load")

    expect(routeIssue("We plan to ship this next week once QA signs off", table).workflows).not.toContain("plan")
    expect(routeIssue("Some ideas here for the onboarding redesign later", table).workflows).not.toContain("brainstorm")
    expect(routeIssue("The theme of this bug report is intermittent failures", table).workflows).not.toContain("design")
  })
})
