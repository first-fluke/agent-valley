import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { z } from "zod"
import { continuousAcceptanceSchema } from "./continuous-acceptance-record"
import { type ContinuousBaseline, continuousBaselineSchema, operationIdSchema } from "./continuous-contract"
import { verifiedMissionEvidence } from "./continuous-recovery"
import { ContinuousOperationStore } from "./continuous-store"
import { parallelGit } from "./parallel-git"
import { MissionStore } from "./store"
import type { Mission } from "./types"

const digest = (content: string) => createHash("sha256").update(content).digest("hex")
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const preparedSchema = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  missionId: operationIdSchema,
  path: z.string(),
  quarantine: z.string(),
  commit: sha,
  tree: sha,
  recoveryCommit: sha,
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // NTFS file IDs exceed Number.MAX_SAFE_INTEGER; JSON round-trips the same double on both sides.
  device: z.number(),
  inode: z.number(),
  at: z.iso.datetime(),
})
const completedSchema = z.strictObject({
  version: z.literal(1),
  preparedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.iso.datetime(),
})

export interface BaselinePruneResult {
  key: string
  path: string
  status: "kept" | "eligible" | "pruned"
  reason: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function localDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
    throw new Error(
      "Pruning requires canonical local directories. Preserve redirected artifacts and restore their original paths.",
    )
}

async function readLocal(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 16_777_216) throw new Error("Unsupported local pruning receipt.")
    return await handle.readFile("utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  } finally {
    await handle?.close()
  }
}

async function immutable(path: string, value: unknown): Promise<string> {
  const content = JSON.stringify(value)
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return content
}

const git = (path: string, args: string[]) =>
  parallelGit(path, ["-c", "core.fsmonitor=false", ...args], { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" })

async function independentGitMetadata(path: string): Promise<void> {
  const pending = [path]
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 100_000) throw new Error("Git metadata inspection exceeded its bound; retain this clone.")
      if (entry.name.endsWith(".lock")) throw new Error("Git metadata has a retained lock; preserve this clone.")
      if (entry.isSymbolicLink()) throw new Error("Git metadata redirects through a symbolic link.")
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
      else if (!entry.isFile()) throw new Error("Git metadata contains an unsupported file type; preserve this clone.")
    }
  }
}

async function emptyScratch(path: string, depth = 0): Promise<boolean> {
  if (depth > 8 || !(await lstat(path)).isDirectory() || (await realpath(path)) !== path) return false
  const entries = await readdir(path)
  if (entries.length > 100) return false
  for (const name of entries) if (!(await emptyScratch(join(path, name), depth + 1))) return false
  return true
}

async function inspectClone(path: string, baseline: ContinuousBaseline): Promise<void> {
  await localDirectory(path)
  await localDirectory(join(path, ".git"))
  await independentGitMetadata(join(path, ".git"))
  for (const key of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "shallow"])
    if (await exists(join(path, ".git", key))) throw new Error("Git metadata depends on another repository.")
  const [top, branch, head, refs, status, worktrees, remotes] = await Promise.all([
    git(path, ["rev-parse", "--show-toplevel"]),
    git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"]),
    git(path, ["worktree", "list", "--porcelain"]),
    git(path, ["remote"]),
  ])
  if (resolve(top.trim()) !== resolve(path) || branch.trim() !== baseline.branch || head.trim() !== baseline.commit)
    throw new Error("Frozen baseline repository identity changed.")
  const expectedRefs = [
    `refs/heads/${baseline.branch} ${baseline.commit}`,
    ...(baseline.missionId
      ? [`refs/heads/av-operation/${baseline.operationId}/${baseline.missionId} ${baseline.baselineHead}`]
      : []),
  ].sort()
  if (JSON.stringify(refs.trim().split("\n").sort()) !== JSON.stringify(expectedRefs) || remotes.trim())
    throw new Error("Frozen baseline has extra Git references or remotes.")
  if (
    worktrees
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => `worktree ${resolve(line.slice("worktree ".length))}`)
      .join("\n") !== `worktree ${resolve(path)}`
  )
    throw new Error("Frozen baseline has linked worktrees.")
  for (const entry of status.split("\0").filter(Boolean)) {
    // Snapshot inspection leaves only empty private index directories behind.
    if (entry === "!! .agent-valley/" && (await emptyScratch(join(path, ".agent-valley")))) continue
    throw new Error("Frozen baseline has tracked, untracked or ignored changes.")
  }
  if ((await git(path, ["rev-parse", "HEAD^{tree}"])).trim() !== baseline.baselineTree)
    throw new Error("Frozen baseline tree differs from its receipt.")
  const reflog = [
    ...new Set((await git(path, ["reflog", "show", "--all", "--format=%H"])).trim().split("\n").filter(Boolean)),
  ]
  if (reflog.length > 100) throw new Error("Unrecorded Git history exceeds its inspection bound; preserve this clone.")
  for (const commit of reflog) {
    try {
      await git(path, ["merge-base", "--is-ancestor", commit, baseline.commit])
    } catch {
      throw new Error("Git reflog contains unrecorded history outside the frozen baseline; preserve this clone.")
    }
  }
}

async function recoverable(current: ContinuousBaseline, baseline: ContinuousBaseline): Promise<void> {
  try {
    await git(current.path, ["merge-base", "--is-ancestor", baseline.commit, current.commit])
  } catch {
    throw new Error("The frozen commit is not proven reachable from the current baseline; retain its clone.")
  }
  if ((await git(current.path, ["rev-parse", `${baseline.commit}^{tree}`])).trim() !== baseline.baselineTree)
    throw new Error("The current baseline does not retain this exact frozen tree.")
  if (
    (await git(current.path, ["rev-list", "--objects", "--missing=print", baseline.commit]))
      .split("\n")
      .some((line) => line.startsWith("?"))
  )
    throw new Error("The current baseline is missing recovery objects.")
}

/** True while a mission has a lock or active-process marker; such missions are never touched by storage cleanup. */
export async function processEvidence(storePath: string, missionId: string): Promise<boolean> {
  if (await exists(join(storePath, `${missionId}.json.lock`))) return true
  if (await exists(join(storePath, `${missionId}.json.lock.reclaim`))) return true
  return (await readdir(storePath)).some(
    (name) => name === `${missionId}.active` || (name.startsWith(`${missionId}.run-`) && name.endsWith(".active")),
  )
}

async function protectMissionBaseline(mission: Mission, protectedPaths: Set<string>): Promise<void> {
  if (!mission.repositoryRoot)
    throw new Error("An unresolved mission has no repository identity; preserve all baselines.")
  protectedPaths.add(mission.workspace.path)
  const workspace = mission.workspace.path
  const prefix = join(mission.repositoryRoot, ".agent-valley", "operations")
  if (!workspace.startsWith(`${prefix}${sep}`)) return
  await localDirectory(dirname(workspace))
  const raw = await readLocal(join(dirname(workspace), "workspace.json"))
  if (!raw) throw new Error("An unresolved mission is missing its workspace receipt; preserve all baselines.")
  const value = JSON.parse(raw) as Record<string, unknown>
  if (
    value.missionId !== mission.id ||
    value.repositoryRoot !== mission.repositoryRoot ||
    value.path !== workspace ||
    typeof value.baselinePath !== "string"
  )
    throw new Error("An unresolved mission has an ambiguous workspace receipt; preserve all baselines.")
  protectedPaths.add(await realpath(value.baselinePath))
}

async function referencedBaselines(
  storageRoot: string,
  operations: Awaited<ReturnType<ContinuousOperationStore["list"]>>,
): Promise<Set<string>> {
  const protectedPaths = new Set<string>()
  const missionDirectories = [join(storageRoot, ".agent-valley", "missions")]
  for (const operation of operations) {
    if (operation.baseline) protectedPaths.add(operation.baseline.path)
    if (operation.sourceIntegration)
      protectedPaths.add(
        join(
          operation.repositoryRoot,
          ".agent-valley",
          "operations",
          operation.id,
          "baselines",
          operation.sourceIntegration.missionId,
          "workspace",
        ),
      )
    for (const id of [operation.currentMissionId, operation.decisionId]) {
      if (!id) continue
      const container = join(operation.repositoryRoot, ".agent-valley", "operations", operation.id, "workspaces", id)
      await localDirectory(container)
      const raw = await readLocal(join(container, "workspace.json"))
      if (!raw) throw new Error("An active child or decision has no workspace receipt; preserve all baselines.")
      const value = JSON.parse(raw) as Record<string, unknown>
      if (value.operationId !== operation.id || value.missionId !== id || typeof value.baselinePath !== "string")
        throw new Error("An active workspace has an ambiguous baseline reference.")
      protectedPaths.add(await realpath(value.baselinePath))
      protectedPaths.add(
        join(operation.repositoryRoot, ".agent-valley", "operations", operation.id, "baselines", id, "workspace"),
      )
    }
    missionDirectories.push(join(storageRoot, ".agent-valley", "operation-decisions", operation.id))
  }
  for (const directory of missionDirectories) {
    if (!(await exists(directory))) continue
    await localDirectory(directory)
    const store = new MissionStore(directory)
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue
      await readLocal(join(directory, name))
      const mission = await store.load(name.slice(0, -5))
      if (
        mission.status !== "completed" ||
        mission.tasks.some((task) => task.effectState === "unknown") ||
        mission.operations?.runs.some((run) => run.executionState && run.executionState !== "settled") ||
        (await processEvidence(directory, mission.id))
      )
        await protectMissionBaseline(mission, protectedPaths)
    }
  }
  return protectedPaths
}

/** Explicit pruning only. Child workspaces, all records and all original receipts are retained. */
export async function pruneContinuousBaselines(
  storageRoot: string,
  operationId: string,
  options: { apply?: boolean; now?: () => Date } = {},
): Promise<{ operationId: string; applied: boolean; candidates: BaselinePruneResult[] }> {
  operationIdSchema.parse(operationId)
  if ((await realpath(storageRoot)) !== resolve(storageRoot))
    throw new Error("Use the original canonical operation storage root.")
  const directory = join(storageRoot, ".agent-valley", "operations")
  await localDirectory(directory)
  const store = new ContinuousOperationStore(directory)
  const unlock = await store.lock(operationId)
  try {
    const operation = await store.load(operationId)
    const root = operation.repositoryRoot
    await localDirectory(root)
    if (resolve((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== resolve(root))
      throw new Error("Restore the original Git repository before pruning.")
    const artifacts = join(root, ".agent-valley", "operations", operationId)
    const baselines = join(artifacts, "baselines")
    await localDirectory(artifacts)
    await localDirectory(baselines)
    const current = operation.baseline
    if (!current) throw new Error("No accepted baseline exists. Preserve the operation artifacts.")
    const protectedPaths = await referencedBaselines(storageRoot, await store.list())
    protectedPaths.add(join(baselines, "initial", "workspace"))
    for (const entry of operation.history.slice(-2)) protectedPaths.add(entry.baselinePath)
    const currentReceipt = continuousBaselineSchema.parse(
      JSON.parse((await readLocal(join(dirname(current.path), "baseline.json"))) ?? "null"),
    )
    if (JSON.stringify(currentReceipt) !== JSON.stringify(current))
      throw new Error("The accepted baseline receipt changed.")
    await inspectClone(current.path, current)
    const missionsPath = join(storageRoot, ".agent-valley", "missions")
    const missions = new MissionStore(missionsPath)
    const candidates: BaselinePruneResult[] = []
    for (const key of (await readdir(baselines)).sort()) {
      const path = join(baselines, key, "workspace")
      let release: (() => Promise<void>) | undefined
      let result: BaselinePruneResult = { key, path, status: "kept", reason: "Retained for inspection." }
      try {
        operationIdSchema.parse(key)
        await localDirectory(dirname(path))
        if (protectedPaths.has(path)) throw new Error("Initial, current, previous or referenced baseline is protected.")
        const raw = await readLocal(join(dirname(path), "baseline.json"))
        const snapshot = continuousBaselineSchema.parse(JSON.parse(raw ?? "null"))
        const transaction = continuousBaselineSchema.parse(
          JSON.parse((await readLocal(join(dirname(path), "snapshot.json"))) ?? "null"),
        )
        if (JSON.stringify(transaction) !== JSON.stringify(snapshot))
          throw new Error("Original snapshot transaction and baseline receipts differ.")
        if (
          snapshot.operationId !== operationId ||
          snapshot.repositoryRoot !== root ||
          snapshot.path !== path ||
          snapshot.missionId !== key ||
          snapshot.branch !== `av-operation/${operationId}/baseline-${key}`
        )
          throw new Error("Baseline identity does not match its private directory.")
        const preparedPath = join(dirname(path), "pruning.json")
        const completedPath = join(dirname(path), "pruned.json")
        const quarantine = join(dirname(path), "workspace.pruning")
        const preparedRaw = await readLocal(preparedPath)
        const prepared = preparedRaw ? preparedSchema.parse(JSON.parse(preparedRaw)) : undefined
        if (
          prepared &&
          (prepared.operationId !== operationId ||
            prepared.missionId !== key ||
            prepared.path !== path ||
            prepared.quarantine !== quarantine ||
            prepared.commit !== snapshot.commit ||
            prepared.tree !== snapshot.baselineTree ||
            prepared.baselineDigest !== digest(raw as string))
        )
          throw new Error("Pruning receipt does not match the frozen baseline.")
        const completedRaw = await readLocal(completedPath)
        if (completedRaw) {
          const completed = completedSchema.parse(JSON.parse(completedRaw))
          if (
            !preparedRaw ||
            completed.preparedDigest !== digest(preparedRaw) ||
            (await exists(path)) ||
            (await exists(quarantine))
          )
            throw new Error("Completed pruning evidence is inconsistent; preserve remaining artifacts.")
          result = { ...result, status: "pruned", reason: "Previously pruned; immutable recovery receipts retained." }
          candidates.push(result)
          continue
        }
        const accepted = operation.history.some((entry) => entry.missionId === key && entry.baselinePath === path)
        const journalRaw = await readLocal(join(dirname(path), "acceptance.json"))
        const journal = journalRaw ? continuousAcceptanceSchema.parse(JSON.parse(journalRaw)) : undefined
        if (
          journal &&
          (journal.operationId !== operationId ||
            journal.repositoryRoot !== root ||
            journal.missionId !== key ||
            journal.baselinePath !== path ||
            journal.commit !== snapshot.commit ||
            journal.tree !== snapshot.baselineTree ||
            journal.cycle > operation.completedCycles)
        )
          throw new Error("Acceptance journal does not match this frozen baseline.")
        if (!accepted && !journal)
          throw new Error(
            "No retained accepted-cycle history or immutable journal proves that this baseline is obsolete.",
          )
        if (await processEvidence(missionsPath, key))
          throw new Error("Mission lock, reclaim or execution marker is present.")
        release = await missions.lock(key)
        const mission = await missions.load(key)
        if (
          mission.repositoryRoot !== root ||
          mission.workspace.path !== snapshot.sourceWorkspacePath ||
          mission.status !== "completed" ||
          !verifiedMissionEvidence(mission) ||
          mission.verification?.fingerprint !== snapshot.verifiedFingerprint
        )
          throw new Error("The original mission lacks settled, verified completion evidence.")
        await recoverable(current, snapshot)
        const hasWorkspace = await exists(path)
        const hasQuarantine = await exists(quarantine)
        if (hasWorkspace && hasQuarantine)
          throw new Error("Both workspace and pruning quarantine exist; preserve both.")
        if (!hasWorkspace && !hasQuarantine) {
          if (!preparedRaw) throw new Error("Missing baseline has no pruning receipt.")
          if (options.apply)
            await immutable(completedPath, {
              version: 1,
              preparedDigest: digest(preparedRaw),
              at: (options.now?.() ?? new Date()).toISOString(),
            })
          result = {
            ...result,
            status: "pruned",
            reason: "Removal completed; retained recovery receipt confirms its identity.",
          }
        } else {
          const physicalPath = hasQuarantine ? quarantine : path
          if (hasQuarantine && !prepared) throw new Error("Unrecorded pruning quarantine is protected.")
          await inspectClone(physicalPath, snapshot)
          const identity = await lstat(physicalPath)
          if (prepared && (identity.dev !== prepared.device || identity.ino !== prepared.inode))
            throw new Error("Workspace identity changed after pruning was prepared.")
          result = {
            ...result,
            status: "eligible",
            reason: "Clean obsolete frozen clone is recoverable from the current baseline commit graph.",
          }
          if (options.apply) {
            const receipt =
              preparedRaw ??
              (await immutable(preparedPath, {
                version: 1,
                operationId,
                missionId: key,
                path,
                quarantine,
                commit: snapshot.commit,
                tree: snapshot.baselineTree,
                recoveryCommit: current.commit,
                baselineDigest: digest(raw as string),
                device: identity.dev,
                inode: identity.ino,
                at: (options.now?.() ?? new Date()).toISOString(),
              }))
            await inspectClone(physicalPath, snapshot)
            const checked = await lstat(physicalPath)
            if (checked.dev !== identity.dev || checked.ino !== identity.ino)
              throw new Error("Workspace identity changed before pruning.")
            if (!hasQuarantine) await rename(path, quarantine)
            await localDirectory(quarantine)
            const moved = await lstat(quarantine)
            if (moved.dev !== identity.dev || moved.ino !== identity.ino)
              throw new Error("Pruning quarantine identity changed.")
            await rm(quarantine, { recursive: true })
            await immutable(completedPath, {
              version: 1,
              preparedDigest: digest(receipt),
              at: (options.now?.() ?? new Date()).toISOString(),
            })
            result = {
              ...result,
              status: "pruned",
              reason: "Removed only the obsolete frozen clone; recovery and mission evidence retained.",
            }
          }
        }
      } catch (error) {
        result = {
          ...result,
          status: "kept",
          reason: error instanceof Error ? error.message : "Uncertain artifact; retained.",
        }
      } finally {
        await release?.()
      }
      candidates.push(result)
    }
    return { operationId, applied: options.apply === true, candidates }
  } finally {
    await unlock()
  }
}
