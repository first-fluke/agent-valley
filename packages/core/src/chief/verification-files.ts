import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { safeVerificationPath } from "./verification-contract"

export const MAX_VERIFICATION_FILE_BYTES = 4_194_304
export const MAX_VERIFICATION_TOTAL_BYTES = 33_554_432

/**
 * The evidence allowance of one verification. Each command binds its inputs before and after it runs, so a
 * Cargo workspace was read six times by three commands and a 5 MB workspace used 30 MB of the 32 MB
 * allowance; one more read failed every later check for a workspace nobody had made larger. Content
 * already charged under the same path is therefore read again without a second charge.
 */
export interface VerificationBudget {
  remaining: number
  charged?: Map<string, string>
}

export function verificationBudget(): VerificationBudget {
  return { remaining: MAX_VERIFICATION_TOTAL_BYTES, charged: new Map() }
}

export async function verificationRoot(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Verification worktree must be a real directory. Restore its original workspace before retrying.")
  return realpath(path)
}

/** A verified file must remain within the worktree without any symbolic-link components. */
export async function verificationFilePath(root: string, name: string): Promise<string> {
  if (!safeVerificationPath(name)) throw new Error("Verification path must be a relative product file.")
  const target = resolve(root, name)
  const rel = relative(root, target)
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Verification file escapes the worktree.")
  let current = root
  const parts = name.split("/")
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`Verification path ${name} contains a symbolic link. Use a real file.`)
    if (index < parts.length - 1 && !info.isDirectory())
      throw new Error(`Verification path ${name} has a non-directory parent. Restore the expected product file.`)
    if (index === parts.length - 1 && !info.isFile())
      throw new Error(`Verification path ${name} is not a regular file. Provide a real product file.`)
  }
  const canonical = await realpath(target)
  if (canonical !== target) throw new Error(`Verification path ${name} changed or escapes the worktree.`)
  return target
}

export async function readVerificationFile(
  root: string,
  name: string,
  budget: VerificationBudget,
): Promise<{ bytes: Buffer; sha256: string }> {
  const target = await verificationFilePath(root, name)
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    const known = budget.charged?.has(name) ?? false
    if (!before.isFile() || before.size > MAX_VERIFICATION_FILE_BYTES || (!known && before.size > budget.remaining))
      throw new Error(`Verification file ${name} exceeds the bounded evidence budget. Use a smaller evidence file.`)
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) {
      const chunk = await file.read(buffer, count, buffer.length - count, count)
      count += chunk.bytesRead
      if (!chunk.bytesRead) break
    }
    const bytes = buffer.subarray(0, count)
    const after = await file.stat()
    const pathInfo = await lstat(await verificationFilePath(root, name))
    if (
      bytes.length > MAX_VERIFICATION_FILE_BYTES ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathInfo.dev ||
      after.ino !== pathInfo.ino
    )
      throw new Error(`Verification file ${name} changed during inspection. Stop concurrent writers and retry.`)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (budget.charged?.get(name) !== sha256) {
      if (bytes.length > budget.remaining)
        throw new Error(`Verification file ${name} exceeds the bounded evidence budget. Use a smaller evidence file.`)
      budget.remaining -= bytes.length
      budget.charged?.set(name, sha256)
    }
    return { bytes, sha256 }
  } finally {
    await file.close()
  }
}

export function jsonPointerValue(value: unknown, pointer: string): unknown {
  for (const encoded of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~")
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
