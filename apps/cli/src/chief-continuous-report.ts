import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { CodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import { containerObservationLines } from "@agent-valley/core/chief/container-observation-state"
import { activeCharterAmendments, type ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { markdown } from "@agent-valley/core/chief/reports"
import { MissionStore } from "@agent-valley/core/chief/store"
import { writeTextAtomic } from "@agent-valley/core/util/atomic-json"

export function operationDeliveryLines(
  operation: ContinuousOperation,
  delivery?: CodeDelivery,
  unavailable = false,
): string[] {
  const integration = operation.sourceIntegration
  const latest = operation.history.at(-1)?.missionId
  const source =
    operation.sourceIntegrationPolicy?.mode === "snapshot-only"
      ? "Source files: automatic worktree application disabled by snapshot-only policy."
      : integration && integration.missionId === latest
        ? `Source files: ${integration.phase}; ${integration.paths.length} paths on ${integration.branch}; source HEAD ${integration.sourceHead}.`
        : operation.sourceIntegrationPolicy?.mode === "worktree"
          ? `Source files: awaiting verified integration on ${operation.sourceIntegrationPolicy.branch}.`
          : "Source files: no source integration receipt recorded; inspect the accepted private baseline."
  return [
    source,
    ...(integration
      ? [`Last source application: child ${integration.missionId}; ${integration.phase} at ${integration.at}.`]
      : []),
    `Remote commit: ${unavailable ? "delivery receipt unavailable" : (delivery?.commitSha ?? "no commit receipt recorded")}.`,
    unavailable
      ? "Remote push: delivery receipt unavailable; outcome unknown."
      : delivery
        ? `Remote push: ${delivery.phase}; ${delivery.policy.remote}/${delivery.policy.branch}.`
        : `Remote push: ${operation.settings.deliver ? "configured; inspect the child delivery receipt" : "not requested"}.`,
  ]
}

export function renderOperationReport(
  operation: ContinuousOperation,
  delivery?: CodeDelivery,
  unavailable = false,
): string {
  const active = new Set(activeCharterAmendments(operation).map((entry) => entry.id))
  const lines = [
    `# Operation ${operation.id}`,
    "",
    `Charter: ${operation.charter}`,
    ...(operation.charterAmendments ?? []).map(
      (entry) =>
        `Charter amendment #${entry.id} at ${entry.at}${active.has(entry.id) ? "" : " (superseded; retained for audit)"}: ${entry.text}`,
    ),
    `Status: ${operation.phase}`,
    `Verified completed improvements: ${operation.completedCycles}${operation.cycleLimit ? ` / ${operation.cycleLimit}` : ""}`,
    `Chief Director: ${operation.settings.actor} / ${operation.settings.model ?? "pinned native default"}`,
    "",
    "AV chooses a concrete improvement, verifies and reviews it, keeps the accepted result, then selects the next improvement. Model calls and API charges can continue until stopped; token savings are not its success criterion.",
    "",
  ]
  if (operation.currentMissionId) lines.push(`Current child: ${operation.currentMissionId}`)
  if (operation.decisionId) {
    lines.push(`Decision checkpoint: ${operation.decisionId}`)
    lines.push(`Decision usage record: .agent-valley/operation-decisions/${operation.id}/${operation.decisionId}.json`)
  }
  if (operation.baseline) lines.push(`Accepted workspace: ${operation.baseline.path}`)
  lines.push(...operationDeliveryLines(operation, delivery, unavailable))
  if (operation.decision) lines.push(`Latest decision: ${operation.decision.action} — ${operation.decision.reason}`)
  if (operation.nextRunAt) lines.push(`Next decision: ${operation.nextRunAt}`)
  if (operation.recovery) {
    lines.push(
      `Recovery disposition: ${operation.recovery.disposition}; ${operation.recovery.target} ${operation.recovery.checkpointId}; ${operation.recovery.attempts} attempts.`,
    )
    lines.push(`Recovery evidence: ${markdown(operation.recovery.reason, 16_000)}`)
    if (operation.recovery.nextRunAt) lines.push(`Next recovery: ${operation.recovery.nextRunAt}`)
  }
  if (operation.error) lines.push(`Paused reason: ${operation.error}`)
  lines.push(
    ...containerObservationLines(operation.containerObservationPolicy, operation.containerObservation).map((line) =>
      markdown(line, 2_200),
    ),
  )
  if (operation.containerObservationRevision)
    lines.push(`Observation transition: ${operation.containerObservationRevision}`)
  for (const entry of operation.history) {
    lines.push("", `## ${entry.goal}`, "", entry.reason, `Verified child: ${entry.missionId}`)
    if (entry.evidence.length) lines.push(`Evidence: ${entry.evidence.join("; ")}`)
  }
  lines.push("", `Resume: av order --resume ${operation.id}`, "")
  return lines.join("\n")
}

export async function saveOperationReport(root: string, operation: ContinuousOperation): Promise<void> {
  const directory = join(root, ".agent-valley", "operation-reports")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const evidence = await deliveryFor(root, operation)
  await writeTextAtomic(
    join(directory, `${operation.id}.md`),
    renderOperationReport(operation, evidence.delivery, evidence.unavailable),
  )
}

async function deliveryFor(
  root: string,
  operation: ContinuousOperation,
): Promise<{ delivery?: CodeDelivery; unavailable?: boolean }> {
  const id = operation.currentMissionId ?? operation.history.at(-1)?.missionId
  if (!id) return {}
  try {
    const mission = await new MissionStore(join(root, ".agent-valley", "missions")).load(id)
    return mission.repositoryRoot === operation.repositoryRoot
      ? { delivery: mission.codeDelivery }
      : { unavailable: true }
  } catch {
    return { unavailable: true }
  }
}

/** Call only after the operation checkpoint has been durably saved. */
export function createOperationProgressReporter(
  root: string,
  write: (line: string) => void = console.log,
): (operation: ContinuousOperation) => Promise<void> {
  let previous: string | undefined
  return async (operation) => {
    const evidence = await deliveryFor(root, operation)
    const lines = [
      `Operation ${operation.id}: ${operation.phase}; ${operation.completedCycles} verified improvements accepted.`,
      ...(operation.baseline
        ? [`Accepted snapshot: ${operation.baseline.path}; commit ${operation.baseline.commit}.`]
        : []),
      ...(operation.currentMissionId ? [`Current child: ${operation.currentMissionId}`] : []),
      ...(operation.decisionId
        ? [
            `${operation.phase === "deciding" ? "Selecting next improvement" : "Decision checkpoint"}: ${operation.decisionId}`,
          ]
        : []),
      ...(operation.nextRunAt ? [`Next decision: ${operation.nextRunAt}`] : []),
      ...operationDeliveryLines(operation, evidence.delivery, evidence.unavailable),
      ...(operation.recovery
        ? [
            `Recovery: ${operation.recovery.disposition}; ${operation.recovery.target} ${operation.recovery.checkpointId}.`,
          ]
        : []),
      ...(operation.error ? [`Paused reason: ${operation.error}`] : []),
    ]
    const key = JSON.stringify(lines)
    if (key === previous) return
    previous = key
    for (const line of lines)
      write(
        [...line]
          .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
          .join(""),
      )
  }
}
