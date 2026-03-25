/**
 * Conflict Guard — utilities for detecting merge-conflict artifacts
 * before auto-commit and delivery.
 */

import { runCommand } from "./workspace-manager"

/** File basenames that require careful merge resolution — not blind --theirs. */
const HIGH_RISK_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pubspec.yaml",
  "pubspec.lock",
  "pyproject.toml",
  "poetry.lock",
  "go.mod",
  "go.sum",
])

export function isHighRiskFile(filePath: string): boolean {
  return HIGH_RISK_BASENAMES.has(filePath.split("/").pop() ?? "")
}

/** Return file paths with unmerged index entries (active merge/rebase conflict). */
export async function getUnmergedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await runCommand("git", ["ls-files", "-u"], { cwd })
  if (!stdout.trim()) return []
  return [
    ...new Set(
      stdout
        .trim()
        .split("\n")
        .map((l) => l.split("\t")[1])
        .filter((f): f is string => !!f),
    ),
  ]
}

/** Scan for git conflict markers. Returns file paths containing <<<<<<< / ======= / >>>>>>>. */
export async function scanConflictMarkers(
  cwd: string,
  opts?: { cached?: boolean; ref?: string; files?: string[] },
): Promise<string[]> {
  // --cached / ref MUST come before the pattern — git interprets them as revisions otherwise
  const args = ["grep"]
  if (opts?.cached) args.push("--cached")
  args.push("-l", "-E", "^(<{7}|={7}|>{7})")
  if (opts?.ref) args.push(opts.ref)
  args.push("--", ":!.agent-valley")
  if (opts?.files?.length) args.push(...opts.files)
  const { exitCode, stdout } = await runCommand("git", args, { cwd })
  if (exitCode !== 0 || !stdout.trim()) return []
  const prefix = opts?.ref ? `${opts.ref}:` : ""
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f))
}

/** Build an actionable diagnostics string for conflict-blocked operations. */
export function buildConflictDiagnostics(files: string[], reason: string): string {
  return `${reason}:\n${files.map((f) => `  - ${f}`).join("\n")}`
}
