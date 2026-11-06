import { realpath } from "node:fs/promises"
import { pruneContinuousBaselines } from "@agent-valley/core/chief/continuous-retention"
import { assertNotManagedRun } from "./managed-run"

export async function pruneOperationArtifacts(
  id: string,
  options: { apply?: boolean } = {},
  root = process.cwd(),
): Promise<void> {
  assertNotManagedRun()
  const result = await pruneContinuousBaselines(await realpath(root), id, options)
  console.log(`Operation ${id} baseline pruning: ${result.applied ? "apply" : "dry run"}.`)
  for (const entry of result.candidates) console.log(`${entry.status}  ${entry.path}\n  ${entry.reason}`)
  if (!result.applied)
    console.log(`No artifacts removed. Apply eligible clones with av operations --prune ${id} --apply.`)
}
