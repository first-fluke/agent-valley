import { lstat, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { RunAttempt, Workspace } from "../domain/models"

/** Analysis is operator-selected; the attempt id in the path prevents reuse of an older report. */
export async function validateAnalysisArtifact(
  workspace: Workspace,
  attempt: RunAttempt,
  reportPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!reportPath.includes("{{attempt.id}}")) {
    return { ok: false, reason: "task.report_path must contain {{attempt.id}}" }
  }
  const expanded = reportPath.replaceAll("{{attempt.id}}", attempt.id)
  if (isAbsolute(expanded) || expanded.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "task.report_path must stay inside the current workspace" }
  }
  try {
    const root = await realpath(workspace.path)
    const candidate = resolve(root, expanded)
    const actual = await realpath(candidate)
    const subpath = relative(root, actual)
    if (subpath === "" || subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) {
      return { ok: false, reason: "analysis report resolves outside the current workspace" }
    }
    if ((await lstat(candidate)).isSymbolicLink()) {
      return { ok: false, reason: "analysis report must not be a symlink" }
    }
    const info = await stat(actual)
    if (!info.isFile() || info.size === 0) return { ok: false, reason: "analysis report is empty or not a file" }
    const started = Date.parse(attempt.startedAt)
    const finished = Date.parse(attempt.finishedAt ?? new Date().toISOString())
    if (!Number.isFinite(started) || info.mtimeMs < started || info.mtimeMs > finished + 2_000) {
      return { ok: false, reason: "analysis report is stale or not bound to the current attempt" }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "analysis report is missing or unreadable" }
  }
}
