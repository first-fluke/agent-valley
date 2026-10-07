import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { matrixReportSchema, type SkillMatrixReport } from "./skill-matrix-schema"

const MAX_BYTES = 4 * 1_024 * 1_024
export interface SkillMatrixDeps {
  now: () => number
  platform: string
  arch: string
  readReport: (path: string) => Promise<unknown>
  plan: (workspace: string, skills: readonly string[], signal?: AbortSignal) => Promise<unknown>
  cliVersion: (vendor: "claude" | "codex", signal?: AbortSignal) => Promise<string | null>
}

async function command(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_BYTES,
        signal,
        ...(binary === "oma" ? { env: { ...process.env, OMA_SKIP_VERSION_CHECK: "1" } } : {}),
      },
      (error, stdout) => {
        // CLI stderr is deliberately omitted: it may contain local configuration or credentials.
        if (error)
          reject(new Error(`${binary} local diagnostic command failed. Check its installation/version and retry.`))
        else resolve(stdout)
      },
    )
  })
}

async function readReport(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Matrix report must be a regular file at most 4 MiB.")
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length !== info.size) throw new Error("Matrix report changed during the read. Retry after its writer finishes.")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))
  } finally {
    await file.close()
  }
}

export const defaultSkillMatrixDeps: SkillMatrixDeps = {
  now: Date.now,
  platform: process.platform,
  arch: process.arch,
  readReport,
  plan: async (workspace, skills, signal) =>
    JSON.parse(
      await command(
        "oma",
        [
          "skills",
          "matrix",
          "--project-root",
          workspace,
          "--skills",
          skills.join(","),
          "--delivery",
          "injected",
          "--vendors",
          "claude,codex",
          "--json",
        ],
        signal,
      ),
    ),
  cliVersion: async (vendor, signal) => {
    const version = (await command(vendor, ["--version"], signal)).trim()
    return /^[\w .()+/-]{1,160}$/.test(version) ? version : null
  },
}

export function parseSkillMatrix(value: unknown): SkillMatrixReport {
  const parsed = matrixReportSchema.safeParse(value)
  if (!parsed.success)
    throw new Error(
      "Matrix report uses an unsupported or malformed evidence contract. Regenerate it with the current OMA CLI.",
    )
  const report = parsed.data
  const unique = (values: string[]) => new Set(values).size === values.length
  if (
    !unique(report.cases.map((entry) => entry.id)) ||
    !unique(report.cells.map((entry) => `${entry.vendor}\0${entry.caseId}`)) ||
    (report.bundle &&
      (!unique(report.bundle.skills.map((entry) => entry.name)) ||
        !unique(report.bundle.skills.map((entry) => entry.caseId)))) ||
    report.cells.some((cell) => !unique(cell.checks.map((check) => check.id)))
  )
    throw new Error("Matrix report repeats a skill, case or vendor cell. Regenerate an unambiguous report.")
  return report
}
