import { join } from "node:path"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { verifiedMissionEvidence } from "@agent-valley/core/chief/continuous-recovery"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { isMissionLockContention } from "./chief-local-recovery"

/** Reattach an implicitly resumed child to its original order after verified completion. */
export async function resumeParentForChild(
  root: string,
  child: Mission,
  resume: (id: string) => Promise<ContinuousOperation>,
): Promise<Mission | ContinuousOperation> {
  if (child.status !== "completed" || !verifiedMissionEvidence(child)) return child
  const directory = join(root, ".agent-valley", "operations")
  const owners = (await new ContinuousOperationStore(directory).list()).filter(
    (operation) => operation.currentMissionId === child.id,
  )
  if (owners.length > 1)
    throw new Error(
      "Multiple orders claim this child. Restore a single owning operation before resuming its accepted result.",
    )
  const owner = owners[0]
  if (!owner || owner.phase === "completed") return child
  if (owner.phase === "paused" && owner.pauseKind !== "blocked" && owner.pauseKind !== "service-shutdown") return child
  if (
    owner.repositoryRoot !== child.repositoryRoot ||
    owner.decision?.action !== "execute" ||
    owner.decision.goal !== child.goal
  )
    throw new Error(
      "Child and owning order identity differ. Restore the original repository and saved execution decision before continuing.",
    )
  const locks = new MissionStore(directory)
  if (await locks.isLocked(owner.id)) return child
  try {
    return await resume(owner.id)
  } catch (error) {
    // A concurrent coordinator owns acceptance; never start a second one or hide other failures.
    if (isMissionLockContention(error, owner.id) && (await locks.isLocked(owner.id))) return child
    throw error
  }
}
