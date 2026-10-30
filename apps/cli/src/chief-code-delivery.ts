import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  type CodeDelivery,
  codeDeliveryPolicySchema,
  successfulCodeDelivery,
} from "@agent-valley/core/chief/code-delivery-contract"
import { assertExecutionDeadline, MissionPause } from "@agent-valley/core/chief/execution"
import { withMissionDeadline } from "@agent-valley/core/chief/execution-signal"
import { finishLocalProcess } from "@agent-valley/core/chief/local-runner"
import type { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { runVerificationGate } from "@agent-valley/core/orchestrator/verification-gate"
import { lockRecord } from "@agent-valley/core/util/record-lock"
import { fingerprintWorkspace } from "@agent-valley/core/workspace/fingerprint"
import { gitRead, prepareDeliveryPatch, shellQuote } from "./chief-code-delivery-git"

class DeliveryBlocked extends Error {}

export interface CodeDeliveryOptions {
  deliver?: string
  deliveryPaths?: string[]
  deliveryMessage?: string
  deliveryRemote?: string
}

async function repositoryRoot(repository: string): Promise<string> {
  const root = await realpath(repository)
  if ((await realpath((await gitRead(root, ["rev-parse", "--show-toplevel"])).trim())) !== root)
    throw new DeliveryBlocked("Select the repository root for code delivery, not a subdirectory.")
  return root
}

async function clean(repository: string): Promise<boolean> {
  return !(await gitRead(repository, ["status", "--porcelain=v1", "--untracked-files=all"]))
}

async function artifact(path: string, content: string | Buffer): Promise<void> {
  try {
    await writeFile(path, content, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || !Buffer.from(content).equals(await readFile(path)))
      throw new DeliveryBlocked("Private delivery artifact changed. Restore its original bytes before resuming.")
  }
}

export async function prepareCodeDelivery(
  repository: string,
  options: CodeDeliveryOptions,
): Promise<CodeDelivery | undefined> {
  if (!options.deliver) {
    if (options.deliveryPaths || options.deliveryMessage || options.deliveryRemote)
      throw new Error("Set --deliver <branch> with explicit --delivery-paths before requesting code delivery.")
    return undefined
  }
  const root = await repositoryRoot(repository)
  const branch = (await gitRead(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()
  await gitRead(root, ["check-ref-format", "--branch", options.deliver])
  if (branch !== options.deliver)
    throw new Error(`Switch the clean source repository to ${options.deliver} before delivery.`)
  if (!(await clean(root)))
    throw new Error(
      "Code delivery requires a clean source index and worktree. Preserve and resolve existing edits first.",
    )
  const remote = options.deliveryRemote ?? "origin"
  const policy = codeDeliveryPolicySchema.parse({
    branch,
    remote,
    paths: options.deliveryPaths,
    message: options.deliveryMessage ?? "fix: apply verified Agent Valley mission",
    baseSha: (await gitRead(root, ["rev-parse", "HEAD"])).trim(),
  })
  await gitRead(root, ["remote", "get-url", policy.remote])
  return { policy, phase: "pending", attempts: 0, updatedAt: new Date().toISOString() }
}

async function privateDirectory(root: string, id: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(id))
    throw new DeliveryBlocked("Restore the original Mission identity before delivery.")
  let current = root
  for (const part of [".agent-valley", "code-delivery", id]) {
    current = join(current, part)
    await mkdir(current, { recursive: true, mode: 0o700 })
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      throw new DeliveryBlocked(
        "Code delivery storage redirects through a symlink. Restore its private local directory.",
      )
  }
  return current
}

function assertLive(mission: Mission, signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DeliveryBlocked(
      "Code delivery was explicitly interrupted. Preserve its checkpoint and inspect the target before resuming.",
    )
  assertExecutionDeadline(mission)
}

async function managedGit(
  mission: Mission,
  store: MissionStore,
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  assertLive(mission, signal)
  const active = store.processGuard(mission.id, "code-delivery")
  active.begin("code-delivery")
  try {
    return await withMissionDeadline(mission, signal, async (boundedSignal) => {
      const remaining =
        mission.execution && mission.executionPolicy
          ? (Date.parse(mission.execution.startedAt) + mission.executionPolicy.maxDurationSec * 1000 - Date.now()) /
            1000
          : mission.timeoutSec
      const result = await runVerificationGate(
        { ...mission.workspace, path: root },
        ["git", ...args.map(shellQuote)].join(" "),
        {
          signal: boundedSignal,
          timeoutSec: remaining,
          onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
          extraEnv: {
            NODE_ENV: process.env.NODE_ENV,
            SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      )
      if (!result.ok)
        throw new Error(
          `Git ${args[0]} failed. Inspect the repository's normal hooks and remote access, then resume this saved delivery.`,
        )
      return result.output ?? ""
    })
  } finally {
    await finishLocalProcess(active)
  }
}

async function assertTarget(root: string, delivery: CodeDelivery) {
  if ((await gitRead(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() !== delivery.policy.branch)
    throw new DeliveryBlocked("The source branch changed. Restore the pinned delivery branch without discarding edits.")
}

async function committedHead(root: string, delivery: CodeDelivery, message: string): Promise<string | undefined> {
  const head = (await gitRead(root, ["rev-parse", "HEAD"])).trim()
  if (head === delivery.policy.baseSha) return undefined
  const [tree, parent, actualMessage] = await Promise.all([
    gitRead(root, ["rev-parse", "HEAD^{tree}"]),
    gitRead(root, ["show", "-s", "--format=%P", "HEAD"]),
    gitRead(root, ["show", "-s", "--format=%B", "HEAD"]),
  ])
  if (
    tree.trim() !== delivery.treeSha ||
    parent.trim() !== delivery.policy.baseSha ||
    actualMessage.trimEnd() !== message.trimEnd()
  )
    throw new DeliveryBlocked(
      "Source HEAD differs from the prepared delivery commit. Preserve it and reconcile the pinned parent, tree and Mission footer.",
    )
  if (!(await clean(root)))
    throw new DeliveryBlocked(
      "The committed source has additional edits. Preserve them and reconcile delivery before continuing.",
    )
  return head
}

async function remoteState(
  mission: Mission,
  store: MissionStore,
  root: string,
  delivery: CodeDelivery,
  signal?: AbortSignal,
) {
  const ref = `refs/heads/${delivery.policy.branch}`
  const output = await managedGit(mission, store, root, ["ls-remote", "--heads", delivery.policy.remote, ref], signal)
  const rows = output.split("\n").filter((line) => line.endsWith(`\t${ref}`))
  if (!rows.length) return "absent" as const
  const remote = rows[0]?.split("\t")[0]
  if (rows.length !== 1 || !remote || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remote))
    throw new DeliveryBlocked("The remote branch observation is ambiguous. Inspect its exact ref before delivery.")
  if (remote === delivery.commitSha) return "delivered" as const
  await managedGit(mission, store, root, ["fetch", "--no-tags", delivery.policy.remote, ref], signal)
  const fetched = (await gitRead(root, ["rev-parse", "FETCH_HEAD"])).trim()
  if (fetched !== remote)
    throw new Error("Remote branch changed during observation. Re-observe it before attempting a push.")
  const ancestor = (
    await gitRead(root, ["merge-base", delivery.commitSha ?? delivery.policy.baseSha, remote]).catch(() => {
      throw new DeliveryBlocked(
        "Remote history has no proven common ancestor with the pinned source. Preserve both histories; reconcile before delivery.",
      )
    })
  ).trim()
  if (delivery.commitSha && ancestor === delivery.commitSha) return "delivered" as const
  if (ancestor === remote && (await gitRead(root, ["merge-base", delivery.policy.baseSha, remote])).trim() === remote)
    return "ancestor" as const
  throw new DeliveryBlocked(
    "The remote branch diverged from the pinned base. Preserve both branches and reconcile; force push is forbidden.",
  )
}

export async function deliverMissionCode(mission: Mission, store: MissionStore, signal?: AbortSignal): Promise<void> {
  const delivery = mission.codeDelivery
  if (!delivery || successfulCodeDelivery(mission) || delivery.phase === "blocked") return
  const previousAttempts = delivery.attempts
  const save = async () => {
    delivery.updatedAt = new Date().toISOString()
    await store.save(mission)
  }
  let unlock: (() => Promise<void>) | undefined
  try {
    assertLive(mission, signal)
    if (mission.operations?.runs.some((run) => run.executionState && run.executionState !== "settled"))
      throw new DeliveryBlocked(
        "An execution is still running or unknown. Confirm its termination before code delivery.",
      )
    if (
      mission.status !== "completed" ||
      !mission.verification?.ok ||
      !mission.finalReview?.passed ||
      !mission.tasks.length ||
      mission.tasks.some(
        (task) =>
          task.status !== "completed" ||
          !task.review?.passed ||
          task.effectState === "unknown" ||
          task.effectState === "running",
      )
    )
      throw new DeliveryBlocked(
        "Code delivery requires completed work, passing independent reviews and the original trusted verification.",
      )
    if (
      !mission.fingerprint ||
      mission.verification.fingerprint !== mission.fingerprint ||
      (await fingerprintWorkspace(mission.workspace.path)) !== mission.fingerprint
    )
      throw new DeliveryBlocked(
        "The verified workspace changed. Re-run its original checks and reviews before delivery.",
      )
    if (!mission.repositoryRoot)
      throw new DeliveryBlocked("Restore the saved source repository identity before delivery.")
    const root = await repositoryRoot(mission.repositoryRoot)
    const gitDirectory = await realpath(resolve(root, (await gitRead(root, ["rev-parse", "--git-common-dir"])).trim()))
    unlock = await lockRecord(join(gitDirectory, "agent-valley-delivery.lock"), "Code delivery", "code-delivery")
    await assertTarget(root, delivery)
    const directory = await privateDirectory(root, mission.id)
    const patchPath = join(directory, "changes.patch")
    if (delivery.phase === "pending") {
      if ((await gitRead(root, ["rev-parse", "HEAD"])).trim() !== delivery.policy.baseSha || !(await clean(root)))
        throw new DeliveryBlocked(
          "Source HEAD or its clean index changed since delivery was authorized. Preserve edits and restore the pinned source before resuming.",
        )
      const prepared = await prepareDeliveryPatch(
        mission.workspace.path,
        delivery.policy.baseSha,
        delivery.policy.paths,
        directory,
      ).catch((error) => {
        throw new DeliveryBlocked(error instanceof Error ? error.message : "Code delivery preparation failed.")
      })
      if ((await fingerprintWorkspace(mission.workspace.path)) !== mission.fingerprint)
        throw new DeliveryBlocked(
          "The workspace changed during delivery capture. Restore its verified bytes before delivery.",
        )
      if (!prepared.changedPaths.length) {
        delivery.phase = "unchanged"
        await save()
        return
      }
      await artifact(patchPath, await readFile(prepared.patchPath))
      delivery.treeSha = prepared.treeSha
      delivery.patchSha256 = prepared.patchSha256
      delivery.verifiedFingerprint = mission.fingerprint
      delivery.nonce = randomUUID()
      delivery.phase = "prepared"
      await save()
    }
    if (!delivery.nonce || delivery.verifiedFingerprint !== mission.fingerprint)
      throw new DeliveryBlocked("Restore the prepared delivery nonce and verified fingerprint before resuming.")
    if (
      createHash("sha256")
        .update(await readFile(patchPath))
        .digest("hex") !== delivery.patchSha256
    )
      throw new DeliveryBlocked(
        "Prepared patch bytes changed. Preserve the delivery record and restore its original patch.",
      )
    const message = `${delivery.policy.message}\n\nAV-Mission: ${mission.id}\nAV-Delivery: ${delivery.nonce}\n`
    const recovered = await committedHead(root, delivery, message)
    if (delivery.commitSha && recovered !== delivery.commitSha)
      throw new DeliveryBlocked(
        "Source HEAD moved away from the saved delivery commit. Preserve it and reconcile before continuing.",
      )
    if (recovered) {
      if (delivery.commitSha && delivery.commitSha !== recovered)
        throw new DeliveryBlocked("The saved delivery commit differs from source HEAD.")
      delivery.commitSha = recovered
      delivery.phase = "committed"
      await save()
      if ((await remoteState(mission, store, root, delivery, signal)) === "delivered") {
        if ((await committedHead(root, delivery, message)) !== delivery.commitSha)
          throw new DeliveryBlocked(
            "Source HEAD changed during remote observation. Preserve both states before resuming.",
          )
        delivery.phase = "pushed"
        delete delivery.error
        delete delivery.nextRunAt
        await save()
        return
      }
    }
    if (delivery.attempts >= 3)
      throw new DeliveryBlocked(
        "Code delivery exhausted three attempts. Preserve its checkpoint and inspect hooks and remote state.",
      )
    if (delivery.nextRunAt && Date.parse(delivery.nextRunAt) > Date.now()) return
    delivery.attempts += 1
    delete delivery.error
    delete delivery.nextRunAt
    await save()
    if (!delivery.commitSha) {
      if (!(await clean(root))) {
        const staged = (await gitRead(root, ["write-tree"])).trim()
        const unstaged = await gitRead(root, ["diff", "--name-only", "-z"])
        const untracked = await gitRead(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        if (staged !== delivery.treeSha || unstaged || untracked)
          throw new DeliveryBlocked(
            "Source has edits outside the exact prepared index. Preserve them and reconcile before commit.",
          )
      } else {
        await gitRead(root, ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath])
      }
      if ((await gitRead(root, ["write-tree"])).trim() !== delivery.treeSha)
        throw new DeliveryBlocked("Staged delivery differs from its verified tree. Preserve the index for inspection.")
      assertLive(mission, signal)
      const messagePath = join(directory, "commit-message.txt")
      await artifact(messagePath, message)
      await managedGit(mission, store, root, ["commit", "--file", messagePath], signal)
      delivery.commitSha = await committedHead(root, delivery, message)
      if (!delivery.commitSha) throw new DeliveryBlocked("Git did not create the exact prepared delivery commit.")
      delivery.phase = "committed"
      await save()
    }
    if ((await remoteState(mission, store, root, delivery, signal)) !== "delivered") {
      try {
        await managedGit(
          mission,
          store,
          root,
          ["push", delivery.policy.remote, `${delivery.commitSha}:refs/heads/${delivery.policy.branch}`],
          signal,
        )
      } catch (error) {
        if (signal?.aborted || error instanceof MissionPause) throw error
      }
      if ((await remoteState(mission, store, root, delivery, signal)) !== "delivered")
        throw new Error(
          "The remote has not confirmed the saved delivery commit. Re-observe this checkpoint before retrying.",
        )
    }
    if ((await committedHead(root, delivery, message)) !== delivery.commitSha)
      throw new DeliveryBlocked("Source HEAD changed during delivery. Preserve both states before resuming.")
    delivery.phase = "pushed"
    delete delivery.error
    await save()
  } catch (error) {
    if (delivery.attempts === previousAttempts) delivery.attempts = Math.min(3, previousAttempts + 1)
    const deadline =
      mission.execution &&
      mission.executionPolicy &&
      Date.now() >= Date.parse(mission.execution.startedAt) + mission.executionPolicy.maxDurationSec * 1000
    const blocked = error instanceof DeliveryBlocked || error instanceof MissionPause || signal?.aborted || deadline
    if (blocked || delivery.attempts >= 3) delivery.phase = "blocked"
    else delivery.nextRunAt = new Date(Date.now() + 5_000).toISOString()
    delivery.error = (
      error instanceof Error ? error.message : "Code delivery failed. Preserve its checkpoint before resuming."
    ).slice(0, 8_000)
    await save()
  } finally {
    await unlock?.()
  }
}
