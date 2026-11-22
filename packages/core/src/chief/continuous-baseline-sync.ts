import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type ContinuousBaseline, type Operation, operationIdSchema } from "./continuous-contract"
import { productPath, regularFile, sourceRoot } from "./continuous-source-helpers"
import { validateContinuousBaseline } from "./continuous-workspace"
import { captureParallelBaseline, parallelGit, parallelTreeImages, writeParallelJson } from "./parallel-git"

type Image = { mode: "100644" | "100755" | "120000"; oid: string }
const imageKey = (image: Image | null) => (image ? `${image.mode} ${image.oid}` : "absent")

/**
 * Every image the given paths held along the accepted baseline lineage. A source commit that lags the
 * baseline carries an earlier accepted cycle, not a new operator change; its images are found here.
 */
async function acceptedLineageImages(
  baselinePath: string,
  commit: string,
  sourceHead: string,
  paths: string[],
): Promise<Map<string, Set<string>>> {
  const images = new Map<string, Set<string>>()
  for (let start = 0; start < paths.length; start += 200) {
    const out = await parallelGit(
      baselinePath,
      [
        "log",
        "--first-parent",
        "--diff-merges=first-parent",
        "--no-renames",
        "--raw",
        "--no-abbrev",
        "-z",
        "--format=",
        commit,
        "--not",
        sourceHead,
        "--",
        ...paths.slice(start, start + 200),
      ],
      { GIT_LITERAL_PATHSPECS: "1" },
    )
    const tokens = out.split("\0")
    for (let index = 0; index + 1 < tokens.length; index++) {
      const meta = tokens[index]?.trim() ?? ""
      if (!meta.startsWith(":")) continue
      const [oldMode = "", newMode = "", oldOid = "", newOid = ""] = meta.slice(1).split(" ")
      const path = tokens[++index] ?? ""
      const seen = images.get(path) ?? new Set<string>()
      for (const [mode, oid] of [
        [oldMode, oldOid],
        [newMode, newOid],
      ])
        seen.add(/^0+$/.test(mode ?? "") ? "absent" : `${mode} ${oid}`)
      images.set(path, seen)
    }
  }
  return images
}

/** Back-propagate committed source product changes from the pinned source HEAD into the accepted operation baseline. */
export async function synchronizeContinuousBaselineWithSource(
  operation: Operation,
  baseline = operation.baseline,
  signal?: AbortSignal,
): Promise<ContinuousBaseline | undefined> {
  signal?.throwIfAborted()
  const policy = operation.sourceIntegrationPolicy
  if (policy?.mode !== "worktree" || !baseline) return baseline
  const root = await sourceRoot(operation.repositoryRoot)
  operationIdSchema.parse(operation.id)
  const current = await validateContinuousBaseline(root, operation.id, baseline.path)
  await parallelGit(current.path, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "--", root, policy.head])
  const ancestor = await parallelGit(current.path, ["merge-base", "--is-ancestor", policy.head, current.commit])
    .then(() => true)
    .catch(() => false)
  if (ancestor) return current
  const baseCommit = await parallelGit(current.path, ["merge-base", current.commit, policy.head])
    .then((out) => out.trim())
    .catch(() => "")
  const baseImages = baseCommit
    ? await parallelTreeImages(current.path, `${baseCommit}^{tree}`)
    : new Map<string, Image>()
  const headImages = await parallelTreeImages(current.path, `${policy.head}^{tree}`)
  const baselineImages = await parallelTreeImages(current.path, current.baselineTree)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const removed: string[] = []
  const upserted: Array<{ path: string; image: Image }> = []
  const contested: Array<{ path: string; after: Image | null }> = []
  for (const path of [...new Set([...baseImages.keys(), ...headImages.keys()])].sort()) {
    if (!productPath(path)) continue
    const before = baseImages.get(path) ?? null
    const after = headImages.get(path) ?? null
    if (same(before, after)) continue
    // A link the operator committed or removed is carried as a tree entry like any other image: this
    // direction only writes the operation's own snapshot, never through a link into the source.
    const existing = baselineImages.get(path) ?? null
    if (same(existing, after)) continue
    if (!same(existing, before)) contested.push({ path, after })
    else if (!after) removed.push(path)
    else upserted.push({ path, image: after })
  }
  if (contested.length) {
    // The baseline changed these paths too. Source wins only with an image the accepted lineage never held;
    // an image it already held is an earlier accepted cycle the operator committed, and the baseline is ahead.
    const lineage = await acceptedLineageImages(
      current.path,
      current.commit,
      policy.head,
      contested.map((entry) => entry.path),
    )
    for (const { path, after } of contested) {
      if (lineage.get(path)?.has(imageKey(after))) continue
      if (!after) removed.push(path)
      else upserted.push({ path, image: after })
    }
  }
  let nextTree = current.baselineTree
  if (removed.length || upserted.length) {
    const index = join(current.path, ".git", `av-sync-index-${randomUUID()}`)
    const removedFile = `${index}.removed`
    const env = { GIT_INDEX_FILE: index }
    try {
      await parallelGit(current.path, ["read-tree", current.baselineTree], env)
      if (removed.length) {
        await writeFile(removedFile, `${removed.join("\0")}\0`, { flag: "wx", mode: 0o600 })
        await parallelGit(
          current.path,
          ["rm", "--cached", "-f", "--ignore-unmatch", `--pathspec-from-file=${removedFile}`, "--pathspec-file-nul"],
          { ...env, GIT_LITERAL_PATHSPECS: "1" },
        )
      }
      for (const entry of upserted) {
        await parallelGit(
          current.path,
          ["update-index", "--add", "--cacheinfo", `${entry.image.mode},${entry.image.oid},${entry.path}`],
          env,
        )
      }
      nextTree = (await parallelGit(current.path, ["write-tree"], env)).trim()
    } finally {
      await rm(removedFile, { force: true })
      await rm(index, { force: true })
      await rm(`${index}.lock`, { force: true })
    }
  }
  const nextCommit = (
    await parallelGit(
      current.path,
      [
        "commit-tree",
        nextTree,
        "-p",
        current.commit,
        "-p",
        policy.head,
        "-m",
        `AV operation ${operation.id} source sync ${policy.head.slice(0, 12)}`,
      ],
      {
        GIT_AUTHOR_NAME: "AV operation snapshot",
        GIT_AUTHOR_EMAIL: "av-snapshot@example.invalid",
        GIT_COMMITTER_NAME: "AV operation snapshot",
        GIT_COMMITTER_EMAIL: "av-snapshot@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    )
  ).trim()
  await parallelGit(current.path, ["reset", "--hard", "-q", nextCommit])
  const updated: ContinuousBaseline = {
    ...current,
    baselineTree: nextTree,
    commit: nextCommit,
  }
  const baselineContainer = dirname(current.path)
  await writeParallelJson(join(baselineContainer, "snapshot.json"), updated)
  await writeParallelJson(join(baselineContainer, "baseline.json"), updated)
  const acceptancePath = join(baselineContainer, "acceptance.json")
  const acceptanceRaw = await regularFile(acceptancePath)
  if (acceptanceRaw) {
    const acceptance = JSON.parse(acceptanceRaw.toString("utf8")) as Record<string, unknown>
    await writeParallelJson(acceptancePath, {
      ...acceptance,
      commit: nextCommit,
      tree: nextTree,
    })
  }
  if (operation.baseline?.path === current.path) operation.baseline = updated
  if (operation.sourceIntegration && operation.sourceIntegration.missionId === current.missionId) {
    operation.sourceIntegration = {
      ...operation.sourceIntegration,
      branch: policy.branch,
      sourceHead: policy.head,
      nextTree,
    }
    const lastHistory = operation.history.at(-1)
    if (lastHistory?.missionId === current.missionId && lastHistory.sourceIntegration) {
      lastHistory.sourceIntegration = {
        ...lastHistory.sourceIntegration,
        branch: policy.branch,
        sourceHead: policy.head,
        nextTree,
      }
    }
  }
  if (operation.decisionId) {
    const decisionContainer = join(
      root,
      ".agent-valley",
      "operations",
      operation.id,
      "workspaces",
      operation.decisionId,
    )
    const workspaceJsonPath = join(decisionContainer, "workspace.json")
    const workspaceRaw = await regularFile(workspaceJsonPath)
    if (workspaceRaw) {
      const record = JSON.parse(workspaceRaw.toString("utf8")) as Record<string, unknown>
      if (record.baselinePath === current.path && typeof record.path === "string") {
        const snapshot = await captureParallelBaseline(record.path)
        if (snapshot.tree === current.baselineTree && snapshot.head === current.commit) {
          await parallelGit(record.path, [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--quiet",
            "--",
            current.path,
            nextCommit,
          ])
          await parallelGit(record.path, ["reset", "--hard", "-q", nextCommit])
          const nextRecord = { ...record, baselineCommit: nextCommit }
          const preparedJsonPath = join(decisionContainer, "prepared.json")
          if (await regularFile(preparedJsonPath)) await writeParallelJson(preparedJsonPath, nextRecord)
          await writeParallelJson(workspaceJsonPath, nextRecord)
        }
      }
    }
  }
  return validateContinuousBaseline(root, operation.id, updated.path)
}
