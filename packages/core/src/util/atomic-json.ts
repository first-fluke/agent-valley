/**
 * Atomic JSON persistence primitives.
 *
 * Write to a unique sibling temp file, then rename over the destination so a
 * crash can only leave a stray temp file — never a truncated record. Records
 * default to 0600 because they hold attempt, budget, and mission state.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface AtomicJsonOptions {
  /** File mode for the final record (default 0600). */
  mode?: number
  /** Pretty-print with two spaces (default true). */
  pretty?: boolean
  /** Use "wx" so an existing temp file is never reused (default true). */
  exclusive?: boolean
  /** Trailing newline (default false). */
  trailingNewline?: boolean
}

function serialize(value: unknown, options: AtomicJsonOptions): string {
  const body = JSON.stringify(value, null, options.pretty === false ? undefined : 2)
  return options.trailingNewline ? `${body}\n` : body
}

function tempPath(path: string): string {
  return `${path}.${randomUUID()}.tmp`
}

/** Atomically replace a text file (markdown, config) with an explicit mode. */
export async function writeTextAtomic(
  path: string,
  content: string,
  options: { mode?: number; exclusive?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = tempPath(path)
  try {
    await writeFile(temporary, content, {
      mode: options.mode ?? 0o600,
      flag: options.exclusive === false ? "w" : "wx",
    })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = tempPath(path)
  try {
    await writeFile(temporary, serialize(value, options), {
      mode: options.mode ?? 0o600,
      flag: options.exclusive === false ? "w" : "wx",
    })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export function writeJsonAtomicSync(path: string, value: unknown, options: AtomicJsonOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = tempPath(path)
  try {
    writeFileSync(temporary, serialize(value, options), {
      mode: options.mode ?? 0o600,
      flag: options.exclusive === false ? "w" : "wx",
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
