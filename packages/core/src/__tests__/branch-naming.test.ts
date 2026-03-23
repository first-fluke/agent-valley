import { describe, expect, test } from "vitest"
import { deriveBranchName } from "../workspace/workspace-manager"

describe("deriveBranchName", () => {
  test("feat → feature/", () => {
    expect(deriveBranchName("FIR-49", "feat(web): add login")).toBe("feature/FIR-49")
  })

  test("fix → fix/", () => {
    expect(deriveBranchName("FIR-50", "fix(api): null pointer")).toBe("fix/FIR-50")
  })

  test("refactor → refactor/", () => {
    expect(deriveBranchName("FIR-51", "refactor: rename module")).toBe("refactor/FIR-51")
  })

  test("hotfix → hotfix/", () => {
    expect(deriveBranchName("FIR-52", "hotfix: critical auth bypass")).toBe("hotfix/FIR-52")
  })

  test("release → release/", () => {
    expect(deriveBranchName("FIR-53", "release: v2.0.0")).toBe("release/FIR-53")
  })

  test("chore → feature/ (unmapped prefix)", () => {
    expect(deriveBranchName("FIR-54", "chore: update deps")).toBe("feature/FIR-54")
  })

  test("test → feature/ (unmapped prefix)", () => {
    expect(deriveBranchName("FIR-55", "test: add e2e tests")).toBe("feature/FIR-55")
  })

  test("no prefix → feature/", () => {
    expect(deriveBranchName("FIR-56", "some random title")).toBe("feature/FIR-56")
  })

  test("empty title → feature/", () => {
    expect(deriveBranchName("FIR-57", "")).toBe("feature/FIR-57")
  })
})
