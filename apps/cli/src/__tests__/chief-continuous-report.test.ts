import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import { mission, operation, timestamp } from "@agent-valley/core/chief/continuous-operation.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createOperationProgressReporter,
  operationDeliveryLines,
  renderOperationReport,
  saveOperationReport,
} from "../chief-continuous-report"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-progress-report-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const receipt = () => ({
  phase: "applied" as const,
  missionId: "child",
  branch: "main",
  sourceHead: "a".repeat(40),
  previousTree: "b".repeat(40),
  nextTree: "c".repeat(40),
  paths: ["product.txt"],
  at: timestamp,
})
const pushed = (): CodeDelivery => ({
  policy: { branch: "main", remote: "origin", paths: ["product.txt"], message: "improve", baseSha: "a".repeat(40) },
  phase: "pushed",
  attempts: 1,
  nonce: "11111111-1111-4111-8111-111111111111",
  treeSha: "b".repeat(40),
  patchSha256: "c".repeat(64),
  verifiedFingerprint: "d".repeat(64),
  commitSha: "e".repeat(40),
  updatedAt: timestamp,
})
const accepted = () =>
  operation({
    repositoryRoot: root,
    completedCycles: 1,
    sourceIntegrationPolicy: { mode: "worktree", branch: "main", head: "a".repeat(40) },
    sourceIntegration: receipt(),
    history: [
      {
        missionId: "child",
        goal: "Improve",
        reason: "Measured",
        evidence: [],
        completedAt: timestamp,
        baselinePath: "/accepted",
      },
    ],
  })

describe("continuous operation saved progress", () => {
  it("distinguishes private snapshots, applied source files and actual remote receipts", () => {
    const value = accepted()
    expect(renderOperationReport(value)).toContain("Source files: applied; 1 paths")
    expect(renderOperationReport(value)).toContain("Remote push: not requested")
    const delivered = renderOperationReport(value, pushed())
    expect(delivered).toContain(`Remote commit: ${"e".repeat(40)}`)
    expect(delivered).toContain("Remote push: pushed; origin/main")
    value.sourceIntegrationPolicy = { mode: "snapshot-only" }
    const earlier = value.history[0]
    if (!earlier) throw new Error("Expected accepted cycle")
    value.history.push({ ...earlier, missionId: "later-child" })
    const snapshotOnly = renderOperationReport(value)
    expect(snapshotOnly).toContain("automatic worktree application disabled by snapshot-only policy")
    expect(snapshotOnly).toContain("Last source application: child child")
    expect(snapshotOnly).not.toContain("Source files: applied")
  })

  it("deduplicates updatedAt-only saves and reports acceptance plus the next saved decision", async () => {
    const write = vi.fn()
    const report = createOperationProgressReporter(root, write)
    const value = operation({ repositoryRoot: root, phase: "deciding", decisionId: "first-decision" })
    await report(value)
    const firstCount = write.mock.calls.length
    value.updatedAt = "2026-11-06T03:00:00.000Z"
    await report(value)
    expect(write).toHaveBeenCalledTimes(firstCount)
    Object.assign(value, accepted(), { decisionId: "next-decision" })
    await report(value)
    expect(write.mock.calls.flat()).toContain("Selecting next improvement: next-decision")
    expect(write.mock.calls.flat()).toContain("Operation operation: deciding; 1 verified improvements accepted.")
    value.phase = "running"
    value.currentMissionId = "worker-child"
    await report(value)
    expect(write.mock.calls.flat()).toContain("Decision checkpoint: next-decision")
    expect(write.mock.calls.flat()).toContain("Current child: worker-child")
  })

  it("reads actual child push receipts and persists them in the operation report", async () => {
    const child = mission("child", "Improve")
    child.repositoryRoot = root
    child.codeDelivery = pushed()
    await new MissionStore(join(root, ".agent-valley", "missions")).save(child)
    const write = vi.fn()
    const report = createOperationProgressReporter(root, write)
    await report(accepted())
    expect(write.mock.calls.flat()).toContain("Remote push: pushed; origin/main.")
    await saveOperationReport(root, accepted())
    expect(await readFile(join(root, ".agent-valley", "operation-reports", "operation.md"), "utf8")).toContain(
      "Remote push: pushed",
    )
  })

  it("keeps corrupt or missing delivery evidence unknown and sanitizes multiline status", async () => {
    const write = vi.fn()
    const report = createOperationProgressReporter(root, write)
    const value = accepted()
    value.error = "preserve\ncheckpoint"
    await report(value)
    expect(write.mock.calls.flat()).toContain("Remote push: delivery receipt unavailable; outcome unknown.")
    expect(write.mock.calls.flat()).toContain("Paused reason: preserve checkpoint")
    const directory = join(root, ".agent-valley", "missions")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "child.json"), "{corrupt")
    await expect(saveOperationReport(root, value)).resolves.toBeUndefined()
    expect(operationDeliveryLines(value, undefined, true).join("\n")).not.toContain("Remote push: pushed")
  })
})
