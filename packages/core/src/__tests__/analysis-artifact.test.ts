import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { RunAttempt, Workspace } from "../domain/models"
import { validateAnalysisArtifact } from "../orchestrator/analysis-artifact"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "av-analysis-check-"))
  dirs.push(path)
  const workspace = { issueId: "i1", path } as Workspace
  const attempt = {
    id: "a1",
    issueId: "i1",
    workspacePath: path,
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    finishedAt: new Date().toISOString(),
  } as RunAttempt
  return { path, workspace, attempt }
}

describe("analysis artifact boundary", () => {
  test("accepts a nonempty report bound to this attempt", async () => {
    const { path, workspace, attempt } = await fixture()
    await writeFile(join(path, "report-a1.md"), "Findings")
    expect(await validateAnalysisArtifact(workspace, attempt, "report-{{attempt.id}}.md")).toEqual({ ok: true })
  })

  test("rejects missing and stale reports", async () => {
    const { path, workspace, attempt } = await fixture()
    expect((await validateAnalysisArtifact(workspace, attempt, "report-{{attempt.id}}.md")).ok).toBe(false)
    const report = join(path, "report-a1.md")
    await writeFile(report, "Old findings")
    await utimes(report, new Date(0), new Date(0))
    expect((await validateAnalysisArtifact(workspace, attempt, "report-{{attempt.id}}.md")).ok).toBe(false)
  })

  test("rejects a report from another attempt or outside the workspace", async () => {
    const { path, workspace, attempt } = await fixture()
    await writeFile(join(path, "report-a2.md"), "Other attempt")
    expect((await validateAnalysisArtifact(workspace, attempt, "report-{{attempt.id}}.md")).ok).toBe(false)
    expect((await validateAnalysisArtifact(workspace, attempt, "../report-{{attempt.id}}.md")).ok).toBe(false)
    const outside = await mkdtemp(join(tmpdir(), "av-analysis-outside-"))
    dirs.push(outside)
    await writeFile(join(outside, "report.md"), "Outside")
    await symlink(join(outside, "report.md"), join(path, "report-a1.md"))
    expect((await validateAnalysisArtifact(workspace, attempt, "report-{{attempt.id}}.md")).ok).toBe(false)
  })
})
