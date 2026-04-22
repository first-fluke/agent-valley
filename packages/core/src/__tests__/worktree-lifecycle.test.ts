/**
 * Unit tests — worktree-lifecycle module (pure helpers only).
 *
 * Filesystem + git behavior for this module is covered end-to-end by the
 * characterization suite (`characterization/workspace-manager.characterization.test.ts`)
 * and by `workspace-safety-net.test.ts`. These unit tests exercise the
 * pure functions in isolation so a regression in path math or branch
 * derivation is caught before the slower e2e suites run.
 *
 * PR2 split: docs/plans/v0-2-bigbang-design.md § 5.4
 */

import { describe, expect, test } from "vitest"
import type { Workspace } from "../domain/models"
import { deriveBranchName, deriveKey, repoRootOf } from "../workspace/worktree-lifecycle"

describe("deriveKey — identifier sanitization", () => {
  test("passes through alphanumerics, dots, dashes, and underscores unchanged", () => {
    expect(deriveKey("PROJ-123")).toBe("PROJ-123")
    expect(deriveKey("abc_1.2-3")).toBe("abc_1.2-3")
  })

  test("replaces disallowed characters with underscores", () => {
    expect(deriveKey("bad name")).toBe("bad_name")
    expect(deriveKey("ns/ID:42")).toBe("ns_ID_42")
  })

  test("replaces multi-byte (UTF-16) code units with one underscore each", () => {
    // Matches the locked characterization in
    // `characterization/workspace-manager.characterization.test.ts` — the regex
    // runs over UTF-16 code units, so every Korean syllable becomes a single "_".
    expect(deriveKey("한글-1")).toBe("__-1")
  })

  test("empty identifier stays empty", () => {
    expect(deriveKey("")).toBe("")
  })
})

describe("deriveBranchName — conventional-prefix mapping", () => {
  test.each([
    ["feat(web): add login", "FIR-49", "feature/FIR-49"],
    ["fix(api): null pointer", "FIR-50", "fix/FIR-50"],
    ["refactor: rename module", "FIR-51", "refactor/FIR-51"],
    ["hotfix: critical auth bypass", "FIR-52", "hotfix/FIR-52"],
    ["release: v2.0.0", "FIR-53", "release/FIR-53"],
  ])("maps conventional title %p (%s) → %s", (title, id, expected) => {
    expect(deriveBranchName(id, title)).toBe(expected)
  })

  test.each([
    ["chore: update deps", "FIR-54", "feature/FIR-54"],
    ["test: add e2e", "FIR-55", "feature/FIR-55"],
    ["some random title", "FIR-56", "feature/FIR-56"],
    ["", "FIR-57", "feature/FIR-57"],
  ])("falls back to feature/ for unmapped or missing prefix %p → %s", (title, id, expected) => {
    expect(deriveBranchName(id, title)).toBe(expected)
  })
})

describe("repoRootOf — recover repo root from workspace path", () => {
  test("strips the trailing /{key} suffix", () => {
    const ws = { path: "/tmp/root/ABC-1", key: "ABC-1" } as Workspace
    expect(repoRootOf(ws, "/fallback")).toBe("/tmp/root")
  })

  test("returns the fallback when path does not contain /{key}", () => {
    const ws = { path: "/outside", key: "ABC-1" } as Workspace
    expect(repoRootOf(ws, "/fallback")).toBe("/fallback")
  })

  test("keeps nested directory structure intact", () => {
    const ws = { path: "/a/b/c/XYZ-99", key: "XYZ-99" } as Workspace
    expect(repoRootOf(ws, "/ignored")).toBe("/a/b/c")
  })
})
