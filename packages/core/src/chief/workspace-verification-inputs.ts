import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { readVerificationFile } from "./verification-files"

export const MAX_WORKSPACE_VERIFICATION_INPUTS = 2_048
const MAX_ENTRIES_SEEN = 20_000
const EXCLUDED_DIRS = new Set([
  ".git",
  ".agent-valley",
  ".agents",
  "node_modules",
  "target",
  ".venv",
  ".build",
  ".dart_tool",
  "vendor",
])

interface WorkspaceInputSpec {
  label: string
  requiredRootFile: string
  matches: (path: string, name: string) => boolean
}

async function collectWorkspaceVerificationInputs(
  root: string,
  budget: { remaining: number },
  spec: WorkspaceInputSpec,
): Promise<{ path: string; sha256: string }[]> {
  const names: string[] = []
  let entriesSeen = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      if (++entriesSeen > MAX_ENTRIES_SEEN) {
        throw new Error(
          `${spec.label} verification workspace is too large to inspect. Remove generated files from source directories or use an operator verification command.`,
        )
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        entry.name.startsWith(".") &&
        !spec.matches(path, entry.name)
      ) {
        continue
      }
      if (entry.isSymbolicLink()) {
        if (spec.matches(path, entry.name) || (await stat(join(root, path)).catch(() => undefined))?.isDirectory()) {
          throw new Error(
            `${spec.label} verification cannot bind symlinked workspace inputs. Keep source files and manifests inside the worktree.`,
          )
        }
        continue
      }
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && spec.matches(path, entry.name)) {
        names.push(path)
        if (names.length > MAX_WORKSPACE_VERIFICATION_INPUTS) {
          throw new Error(
            `${spec.label} verification exceeds ${MAX_WORKSPACE_VERIFICATION_INPUTS} input files. Use an operator verification command for this workspace.`,
          )
        }
      }
    }
  }
  await visit("")
  if (!names.includes(spec.requiredRootFile)) {
    throw new Error(
      `${spec.label} verification requires ${spec.requiredRootFile} in the mission worktree root. Create the requested workspace before verifying it.`,
    )
  }
  const inputs: { path: string; sha256: string }[] = []
  for (const path of names.sort()) {
    const file = await readVerificationFile(root, path, budget)
    inputs.push({ path, sha256: file.sha256 })
  }
  return inputs
}

/** Bind native Go workspace checks to go.mod/go.sum/go.work manifests and Go source files. */
export async function goVerificationInputs(
  root: string,
  budget: { remaining: number },
): Promise<{ path: string; sha256: string }[]> {
  return collectWorkspaceVerificationInputs(root, budget, {
    label: "Go",
    requiredRootFile: "go.mod",
    matches: (_path, name) => name.endsWith(".go") || ["go.mod", "go.sum", "go.work", "go.work.sum"].includes(name),
  })
}

/** Bind native SwiftPM checks to Package.swift, Package.resolved, and Swift source files. */
export async function swiftVerificationInputs(
  root: string,
  budget: { remaining: number },
): Promise<{ path: string; sha256: string }[]> {
  return collectWorkspaceVerificationInputs(root, budget, {
    label: "Swift",
    requiredRootFile: "Package.swift",
    matches: (_path, name) => name.endsWith(".swift") || name === "Package.swift" || name === "Package.resolved",
  })
}

/** Bind native Dart workspace checks to pubspec/analysis manifests and Dart source files. */
export async function dartVerificationInputs(
  root: string,
  budget: { remaining: number },
): Promise<{ path: string; sha256: string }[]> {
  return collectWorkspaceVerificationInputs(root, budget, {
    label: "Dart",
    requiredRootFile: "pubspec.yaml",
    matches: (_path, name) =>
      name.endsWith(".dart") || ["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"].includes(name),
  })
}
