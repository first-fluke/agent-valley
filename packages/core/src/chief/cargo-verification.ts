import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { readVerificationFile } from "./verification-files"

export const MAX_CARGO_VERIFICATION_INPUTS = 2_048
const excluded = new Set([".git", ".agent-valley", ".agents", "node_modules", "target", ".venv"])

function cargoInput(path: string, name: string): boolean {
  return (
    name.endsWith(".rs") ||
    [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain",
      "rust-toolchain.toml",
      "rustfmt.toml",
      ".rustfmt.toml",
      "clippy.toml",
      ".clippy.toml",
    ].includes(name) ||
    /(?:^|\/)\.cargo\/(?:config|config\.toml)$/.test(path)
  )
}

/** Bind native workspace checks to their manifests, Rust files and local tool configuration. */
export async function cargoVerificationInputs(
  root: string,
  budget: { remaining: number },
): Promise<{ path: string; sha256: string }[]> {
  const names: string[] = []
  let entriesSeen = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue
      if (++entriesSeen > 20_000)
        throw new Error(
          "Cargo verification workspace is too large to inspect. Remove generated files from source directories or use an operator verification command.",
        )
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        entry.name.startsWith(".") &&
        entry.name !== ".cargo" &&
        !cargoInput(path, entry.name)
      )
        continue
      if (entry.isSymbolicLink()) {
        if (cargoInput(path, entry.name) || (await stat(join(root, path))).isDirectory())
          throw new Error(
            "Cargo verification cannot bind symlinked workspace inputs. Keep source files and Cargo configuration inside the worktree.",
          )
        continue
      }
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && cargoInput(path, entry.name)) {
        names.push(path)
        if (names.length > MAX_CARGO_VERIFICATION_INPUTS)
          throw new Error(
            "Cargo verification exceeds 2048 input files. Use an operator verification command for this workspace.",
          )
      }
    }
  }
  await visit("")
  if (!names.includes("Cargo.toml"))
    throw new Error(
      "Cargo verification requires Cargo.toml in the mission worktree root. Create the requested Rust workspace before verifying it.",
    )
  const inputs: { path: string; sha256: string }[] = []
  for (const path of names.sort()) {
    const file = await readVerificationFile(root, path, budget)
    inputs.push({ path, sha256: file.sha256 })
  }
  return inputs
}
