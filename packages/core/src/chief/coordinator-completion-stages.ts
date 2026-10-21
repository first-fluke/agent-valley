import { ensureCurrentMissionContainers, verifyMissionContainers } from "./coordinator-container"
import { applyVerificationResult } from "./coordinator-results"
import { assertCurrentReviewGates } from "./coordinator-review-gates"
import { ReadOnlyViolation } from "./coordinator-run"
import type { CoordinatorContext, StageTransition } from "./coordinator-stages"
import { MissionPause, pauseForFailure, recordPause } from "./execution"
import { reviewPrompt } from "./prompts"
import { fallbackReport } from "./reports"
import { reviewGatesAreCurrent } from "./review-gate-check"
import { parseFinalReview } from "./schemas"

export async function verifyMission(context: CoordinatorContext): Promise<StageTransition> {
  const {
    mission,
    ports,
    checkpoint,
    save,
    checkAbort,
    assertContract,
    protectedFailure,
    requestRecovery,
    requestRepair,
  } = context
  await checkpoint.transition("verifying", "verify", "Running the operator's verification command.")
  checkAbort()
  let result: { ok: boolean; output?: string }
  try {
    result = await ports.verify(mission)
    assertContract()
  } catch (error) {
    if (!mission.supervision || protectedFailure(error)) throw error
    await requestRecovery(`Verification process failed: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: "next", stage: "tasks" }
  }
  checkAbort()
  applyVerificationResult(mission, result, await ports.fingerprint(mission))
  await save("verify", mission.verification.ok ? "Verification passed." : "Verification failed.")
  if (!mission.verification.ok) {
    await requestRepair(mission.verification.output ?? "The operator's verification command failed")
    return { kind: "next", stage: "tasks" }
  }
  if (!reviewGatesAreCurrent(mission, mission.verification.fingerprint)) {
    if ((mission.gateReviewRefreshes ?? 0) >= mission.maxRepairs + 1) {
      await requestRecovery(
        "Verification repeatedly changes files already inspected by review gates. Make verification stable before retrying; the saved gate refresh allowance is exhausted.",
      )
      return { kind: "next", stage: "tasks" }
    }
    mission.gateReviewRefreshes = (mission.gateReviewRefreshes ?? 0) + 1
    await save("review-gates", "Verification changed the inspected files; refreshing configured review gates.")
    return { kind: "next", stage: "review-gates" }
  }
  return { kind: "next", stage: "approval" }
}

export async function approveMission(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, run, persona, save, checkAbort, protectedFailure, requestRecovery, requestRepair } = context
  mission.status = "reviewing"
  assertCurrentReviewGates(mission)
  const recovery = await verifyMissionContainers(mission, ports, save, checkAbort)
  if (!recovery.healthy) {
    await requestRecovery(`Configured service recovery remains unresolved after code checks: ${recovery.reason}`)
    return { kind: "next", stage: "tasks" }
  }
  if (ports.refreshOrganization) {
    mission.organizationContext = await ports.refreshOrganization(mission)
    await save("organization", "Loaded current operator-recorded metrics and organization evidence for final review.")
  }
  if (ports.observeMetrics && mission.metricSourcePolicy && mission.operatingPolicy?.metricTargets?.length) {
    mission.observationStartedAt ??= new Date().toISOString()
    await save("observation", "Observing fresh business measurements against the original metric targets.")
    const observation = await ports.observeMetrics(mission)
    checkAbort()
    if (observation.status === "waiting") {
      recordPause(mission, new MissionPause(observation.reason, "provider", observation.nextPollAt))
      await save("waiting", observation.reason)
      mission.report = fallbackReport(mission)
      await context.checkpoint.persist()
      return { kind: "return" }
    }
    if (observation.status === "failed") {
      delete mission.observationStartedAt
      await requestRecovery(`Business measurement did not meet the original target: ${observation.reason}`)
      return { kind: "next", stage: "tasks" }
    }
  }
  await save("final-review", "Chief Director is reviewing the completed mission and verification evidence.")
  try {
    mission.finalReview = parseFinalReview(
      await run(persona(mission.chiefId), reviewPrompt(mission), "final-review"),
      mission,
    )
  } catch (error) {
    if (!mission.supervision || protectedFailure(error)) throw error
    pauseForFailure(mission, error instanceof Error ? error.message : String(error))
    await requestRecovery(`Final review could not complete: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: "next", stage: "tasks" }
  }
  await save("final-review", mission.finalReview.summary)
  if (!mission.finalReview.passed) {
    await requestRepair(mission.finalReview.findings.join("; "))
    return { kind: "next", stage: "tasks" }
  }
  if ((await ports.fingerprint(mission)) !== mission.verification?.fingerprint) {
    throw new Error("Worktree changed after verification. Resume to rerun task reviews and verification.")
  }
  assertCurrentReviewGates(mission)
  if (!(await ensureCurrentMissionContainers(mission, ports, save, checkAbort, requestRecovery)))
    return { kind: "next", stage: "tasks" }
  return { kind: "next", stage: "report" }
}

export async function reportMission(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, checkpoint, save, checkAbort, generateReport, requestRecovery } = context
  await generateReport()
  if ((await ports.fingerprint(mission)) !== mission.verification?.fingerprint)
    throw new ReadOnlyViolation(
      "Worktree changed after the Chief Director report. Resume to refresh verification and approvals.",
    )
  assertCurrentReviewGates(mission)
  if (!(await ensureCurrentMissionContainers(mission, ports, save, checkAbort, requestRecovery)))
    return { kind: "next", stage: "tasks" }
  await checkpoint.transition(
    "completed",
    "completed",
    "Every task passed independent review, verification passed, and the Chief Director approved the mission.",
  )
  return { kind: "return" }
}
