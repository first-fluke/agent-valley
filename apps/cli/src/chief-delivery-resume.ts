import { realpath } from "node:fs/promises"
import { join } from "node:path"
import type { CodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { prepareCodeDelivery } from "./chief-code-delivery"
import { deliveryPaths, type OrderOptions } from "./chief-config"

export const deliveryResumeKeys = [
  "deliver",
  "deliveryPaths",
  "deliveryMessage",
  "deliveryRemote",
  "deliverySkipPrePush",
] as const

export function hasDeliveryResumeOptions(options: OrderOptions): boolean {
  return deliveryResumeKeys.some((key) => options[key] !== undefined)
}

function request(options: OrderOptions) {
  const paths = deliveryPaths(options.deliveryPaths)
  if (!options.deliver || !paths?.length)
    throw new Error(
      "Enable delivery with --resume <id> --deliver <branch> --delivery-paths '<JSON array of exact product files>'. Existing goals, checks and spent limits are retained.",
    )
  return { ...options, deliveryPaths: paths }
}

function assertStopped(mission: Mission): void {
  if (
    mission.operations?.runs.some(
      (run) => run.executionState === "running" || run.executionState === "unknown" || !run.finishedAt,
    ) ||
    mission.tasks.some((task) => task.effectState === "running" || task.effectState === "unknown")
  )
    throw new Error(
      "Code delivery cannot be enabled while execution or external effects are running or unknown. Confirm termination and reconcile the saved execution/effect before resuming; no delivery policy was changed.",
    )
}

function assertSamePolicy(existing: CodeDelivery, options: ReturnType<typeof request>): void {
  const samePaths = [...existing.policy.paths].sort().join("\0") === [...options.deliveryPaths].sort().join("\0")
  if (
    existing.policy.branch !== options.deliver ||
    !samePaths ||
    (options.deliveryMessage !== undefined && existing.policy.message !== options.deliveryMessage.trim()) ||
    (options.deliveryRemote !== undefined && existing.policy.remote !== options.deliveryRemote) ||
    (options.deliverySkipPrePush !== undefined &&
      (existing.policy.skipPrePush ?? false) !== options.deliverySkipPrePush)
  )
    throw new Error(
      "Code delivery already has a saved branch, paths, message and hook policy. Those bindings and delivery receipts cannot be replaced; resume without replacement delivery options.",
    )
}

/** Caller holds the Mission lock and has reconciled its process guards before enabling remote delivery. */
export async function enableMissionDelivery(
  mission: Mission,
  options: OrderOptions,
  store: Pick<MissionStore, "save">,
): Promise<boolean> {
  if (!hasDeliveryResumeOptions(options)) return false
  const requested = request(options)
  assertStopped(mission)
  if (mission.codeDelivery) {
    assertSamePolicy(mission.codeDelivery, requested)
    return false
  }
  if (!mission.repositoryRoot)
    throw new Error(
      "Restore the saved source repositoryRoot before enabling delivery; the Mission workspace is not the source branch.",
    )
  const policy = await prepareCodeDelivery(mission.repositoryRoot, requested)
  if (!policy) throw new Error("Set --deliver <branch> before enabling remote code delivery.")
  const at = new Date().toISOString()
  mission.codeDelivery = policy
  mission.history.push({
    at,
    stage: "code-delivery-enabled",
    message: JSON.stringify({
      branch: policy.policy.branch,
      remote: policy.policy.remote,
      baseSha: policy.policy.baseSha,
      paths: policy.policy.paths,
      skipPrePush: policy.policy.skipPrePush ?? false,
    }),
  })
  await store.save(mission)
  return true
}

/** Caller holds the operation lock; an active child is updated under its own lock before the parent settings. */
export async function enableOperationDelivery(
  operation: ContinuousOperation,
  options: OrderOptions,
  root: string,
  save: (operation: ContinuousOperation) => Promise<void>,
  onEnable?: (operation: ContinuousOperation) => void,
): Promise<boolean> {
  if (!hasDeliveryResumeOptions(options)) return false
  const requested = request(options)
  if ((await realpath(String(operation.settings.workspace))) !== (await realpath(operation.repositoryRoot)))
    throw new Error(
      "Operation source repository no longer matches its pinned workspace. Restore the original source before enabling delivery.",
    )
  let policy: CodeDelivery
  if (typeof operation.settings.deliver === "string") {
    const existing = await prepareCodeDelivery(operation.repositoryRoot, {
      deliver: operation.settings.deliver,
      deliveryPaths: deliveryPaths(operation.settings.deliveryPaths as string | undefined),
      deliveryMessage: operation.settings.deliveryMessage as string | undefined,
      deliveryRemote: operation.settings.deliveryRemote as string | undefined,
      deliverySkipPrePush: operation.settings.deliverySkipPrePush as boolean | undefined,
    })
    if (!existing) throw new Error("Restore the original operation delivery policy before resuming.")
    assertSamePolicy(existing, requested)
    policy = existing
  } else {
    const prepared = await prepareCodeDelivery(operation.repositoryRoot, requested)
    if (!prepared) throw new Error("Set --deliver <branch> before enabling operation delivery.")
    policy = prepared
  }
  let unlock: (() => Promise<void>) | undefined
  try {
    if (operation.currentMissionId) {
      const missions = new MissionStore(join(root, ".agent-valley", "missions"))
      unlock = await missions.lock(operation.currentMissionId)
      const child = await missions.load(operation.currentMissionId)
      if (
        child.repositoryRoot !== operation.repositoryRoot ||
        child.goal !== (operation.decision?.action === "execute" ? operation.decision.goal : undefined)
      )
        throw new Error(
          "The active child does not match the operation's original source and goal. Restore its checkpoint before enabling delivery.",
        )
      await missions.recoverProcesses(child.id, child)
      await enableMissionDelivery(child, options, missions)
    }
    operation.settings = {
      ...operation.settings,
      deliver: policy.policy.branch,
      deliveryPaths: JSON.stringify(policy.policy.paths),
      deliveryMessage: policy.policy.message,
      deliveryRemote: policy.policy.remote,
      ...(policy.policy.skipPrePush !== undefined ? { deliverySkipPrePush: policy.policy.skipPrePush } : {}),
    }
    onEnable?.(operation)
    await save(operation)
    return true
  } finally {
    await unlock?.()
  }
}
