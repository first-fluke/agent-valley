/**
 * Unit tests — safety-net module (pure classifiers + parsers).
 *
 * The git-integration paths (validateWorktreeBeforeAutoCommit / autoCommit)
 * are covered end-to-end by `workspace-safety-net.test.ts` and the
 * `characterization/workspace-manager.characterization.test.ts` suite.
 * This file exercises the classification helpers that the rest of the
 * safety-net (and `delivery-strategy`) builds on.
 *
 * PR2 split: docs/plans/v0-2-bigbang-design.md § 5.4
 */

import { describe, expect, test } from "vitest"
import {
  buildLockfileRetryPrompt,
  CONFLICT_MARKER_PATTERN,
  type ConflictClassificationLabels,
  classifyConflictFiles,
  isHighRiskConflictFile,
  isRegeneratableLockfile,
  parseNullSeparatedPaths,
} from "../workspace/safety-net"

describe("isRegeneratableLockfile", () => {
  test.each([
    ["package-lock.json", true],
    ["bun.lockb", true],
    ["bun.lock", true],
    ["pnpm-lock.yaml", true],
    ["yarn.lock", true],
    ["uv.lock", true],
    ["go.sum", true],
    ["nested/dir/package-lock.json", true],
    ["package.json", false],
    ["src/index.ts", false],
  ])("classifies %s → %p", (file, expected) => {
    expect(isRegeneratableLockfile(file)).toBe(expected)
  })
})

describe("isHighRiskConflictFile", () => {
  test.each([
    ["package.json", true],
    ["pyproject.toml", true],
    ["go.mod", true],
    ["middleware.ts", true],
    ["auth.ts", true],
    ["auth-client.ts", true],
    ["env.local", true],
    ["config.toml", true],
    ["auth/session.ts", true],
    ["src/unrelated.ts", false],
    ["README.md", false],
    ["package-lock.json", false],
  ])("classifies %s → %p", (file, expected) => {
    expect(isHighRiskConflictFile(file)).toBe(expected)
  })
})

describe("CONFLICT_MARKER_PATTERN", () => {
  test("matches lines beginning with <<<<<<<, =======, or >>>>>>>", () => {
    expect(CONFLICT_MARKER_PATTERN.test("ok\n<<<<<<< HEAD\nfoo\n")).toBe(true)
    expect(CONFLICT_MARKER_PATTERN.test("=======\n")).toBe(true)
    expect(CONFLICT_MARKER_PATTERN.test(">>>>>>> branch\n")).toBe(true)
  })

  test("does not match benign text", () => {
    expect(CONFLICT_MARKER_PATTERN.test("const x = 1\nconst y = 2\n")).toBe(false)
    expect(CONFLICT_MARKER_PATTERN.test("<< less than\n")).toBe(false)
  })
})

describe("buildLockfileRetryPrompt", () => {
  test("includes each file and the sync-before-regenerate instruction", () => {
    const prompt = buildLockfileRetryPrompt(["package-lock.json", "bun.lockb"])
    expect(prompt).toContain("package-lock.json")
    expect(prompt).toContain("bun.lockb")
    expect(prompt).toContain("dependency install or sync")
    expect(prompt).toContain("Sync your branch")
  })

  test("still produces a prompt for a single file", () => {
    const prompt = buildLockfileRetryPrompt(["yarn.lock"])
    expect(prompt).toContain("yarn.lock")
    expect(prompt).toMatch(/Retry instruction/)
  })
})

describe("parseNullSeparatedPaths", () => {
  test("returns an empty array for empty input", () => {
    expect(parseNullSeparatedPaths("")).toEqual([])
  })

  test("parses a single porcelain-v1 entry and strips the 3-char status prefix", () => {
    // porcelain v1 -z format: "XY <path>\0"
    expect(parseNullSeparatedPaths("?? new.ts\0")).toEqual(["new.ts"])
  })

  test("parses multiple entries separated by nulls", () => {
    expect(parseNullSeparatedPaths("?? a.ts\0 M b.ts\0")).toEqual(["a.ts", "b.ts"])
  })

  test("consumes the extra token that rename (R) entries emit", () => {
    // git emits "R  dest\0src\0" — we lock the current behavior: pick up src.
    expect(parseNullSeparatedPaths("R  dest.ts\0src.ts\0")).toEqual(["src.ts"])
  })

  test("skips entries shorter than the 3-char status prefix", () => {
    expect(parseNullSeparatedPaths("\0\0XY\0")).toEqual([])
  })
})

describe("classifyConflictFiles", () => {
  const labels: ConflictClassificationLabels = {
    retryablePrefix: "Conflict markers in regeneratable lockfiles",
    retryableFix: "Regenerate.",
    manualPrefix: "Conflict markers in changed files",
    manualFix: "Resolve manually.",
  }

  test("marks retryable when every file is a regeneratable lockfile", () => {
    const r = classifyConflictFiles(["package-lock.json", "bun.lockb"], labels)
    expect(r.ok).toBe(false)
    expect(r.retryable).toBe(true)
    expect(r.error).toContain("regeneratable lockfiles")
    expect(r.retryPrompt).toContain("dependency install or sync")
  })

  test("marks non-retryable manual when any file is not a lockfile", () => {
    const r = classifyConflictFiles(["package-lock.json", "package.json"], labels)
    expect(r.ok).toBe(false)
    expect(r.retryable).toBeUndefined()
    expect(r.error).toContain("Conflict markers in changed files")
    expect(r.error).toContain("package.json")
    expect(r.retryPrompt).toBeUndefined()
  })

  test("uses the supplied fix label in the error message", () => {
    const r = classifyConflictFiles(["unknown.ts"], labels)
    expect(r.error).toContain("Resolve manually.")
  })
})
