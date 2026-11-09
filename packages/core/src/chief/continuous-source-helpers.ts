import { lstat, readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { codeDeliveryPath } from "./code-delivery-contract"
import { parallelGit } from "./parallel-git"

export async function regularFile(path: string): Promise<Buffer | undefined> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return undefined
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new Error(
      "Source integration receipts must be regular local files. Restore their original bytes before retrying.",
    )
  return readFile(path)
}

export async function sourceRoot(repositoryRoot: string): Promise<string> {
  const root = await realpath(repositoryRoot)
  if (
    root !== resolve(repositoryRoot) ||
    (await realpath((await parallelGit(root, ["rev-parse", "--show-toplevel"])).trim())) !== root
  )
    throw new Error("Use the original canonical Git repository root for source integration.")
  return root
}

export function productPath(path: string): boolean {
  return (
    codeDeliveryPath(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          /^\.(?:claude|codex|cursor|qwen|dsh|zcode|grok|kimi|gemini|opencode|kilo|kilocode|antigravity|mcp)(?:\.|$)/i.test(
            part,
          ) ||
          /^(?:opencode\.jsonc?|kilo\.jsonc?|mcp\.json|\.cursorrules|\.cursorignore|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(
            part,
          ) ||
          [".config", ".aws", ".ssh", ".azure"].includes(part) ||
          part === "AGENT_SETUP.md" ||
          part === "AGENTS.md" ||
          part === ".agent-vally",
      )
  )
}
