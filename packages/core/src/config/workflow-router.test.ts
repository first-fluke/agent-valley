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
          en: ["fix bug", "fix the bug"],
          ko: ["버그 고쳐줘", "고쳐줘"],
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

  test("word-boundary guard prevents 'work' from matching inside 'framework'", () => {
    const table = makeTable()
    const result = routeIssue("Upgrade the framework used by the network layer", table)
    expect(result.workflows).not.toContain("work")
  })

  test("CJK keywords match without word-boundary guards", () => {
    const table = makeTable({
      workflows: {
        design: { persistent: false, keywords: { ko: ["디자인"] } },
      },
    })
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

// ── excludedWorkflows ─────────────────────────────────────────────────

describe("routeIssue excludedWorkflows", () => {
  test("an excluded workflow never routes even when its keyword matches", () => {
    const table = makeTable()
    const result = routeIssue("Please check the tools for this task", table)
    expect(result.workflows).not.toContain("tools")
  })
})

// ── informationalPatterns suppression ────────────────────────────────

describe("routeIssue informationalPatterns", () => {
  test("a purely informational question does not trigger a persistent workflow", () => {
    const table = makeTable()
    const result = routeIssue("What is the orchestrate workflow and how does it work?", table)
    expect(result.workflows).not.toContain("orchestrate")
  })

  test("Korean informational question does not trigger a persistent workflow", () => {
    const table = makeTable()
    const result = routeIssue("work 워크플로우가 뭐야?", table)
    expect(result.workflows).not.toContain("work")
  })

  test("a genuine (non-question) request still triggers a persistent workflow", () => {
    const table = makeTable()
    const result = routeIssue("Please orchestrate the release across all three services in parallel", table)
    expect(result.workflows).toContain("orchestrate")
  })

  test("a non-persistent workflow is not suppressed just because it is a question", () => {
    const table = makeTable()
    // "debug" is not persistent, so the isAnalyticalIssue gate never applies
    // to it — but the windowed informational-context suppression still can.
    const result = routeIssue("My app crashed, can you debug it for me right now?", table)
    expect(result.workflows).toContain("debug")
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
  })

  test("real triggers.json routes a debug+backend sample issue", () => {
    const table = loadTriggerTable(projectRoot)
    expect(table).not.toBeNull()
    if (!table) throw new Error("expected table to load")
    const result = routeIssue("Debug the backend service auth flow — users can't log in", table)
    expect(result.workflows).toContain("debug")
    expect(result.skills).toContain("oma-backend")
  })
})
