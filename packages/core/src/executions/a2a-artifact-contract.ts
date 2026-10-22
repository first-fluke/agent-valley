import { z } from "zod"

export const A2A_ARTIFACT_MAX_FILE_BYTES = 1024 * 1024
export const A2A_ARTIFACT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const protectedDirectories = new Set([
  ".git",
  ".agent-valley",
  ".agents",
  ".codex",
  ".claude",
  ".cursor",
  ".qwen",
  ".kiro",
  ".ssh",
  ".aws",
  "node_modules",
])
const protectedNames =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.gitconfig|av\.ya?ml|settings\.ya?ml|\.?(?:auth|tokens?|oauth)\.(?:json|ya?ml|toml)|\.?credentials?(?:[._-].*)?|\.?secrets?(?:[._-].*)?|service-account(?:[^/]*)\.json|agents\.md|claude\.md|id_(?:rsa|dsa|ecdsa|ed25519).*)$/i
const protectedExtensions = /\.(?:pem|key|p12|pfx|keystore|jks|tfvars|tfstate)(?:\..*)?$/i

/** Exact literal product paths; remote artifacts cannot modify credentials or AV instructions. */
export function assertA2aPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > 240 || path.includes("\\") || path.includes(":"))
    throw new Error(
      "A2A artifact path must be a literal relative product path. Select an allowed file inside the repository.",
    )
  const parts = path.split("/")
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(part) ||
        protectedDirectories.has(part.toLowerCase()) ||
        protectedNames.test(part) ||
        protectedExtensions.test(part),
    )
  )
    throw new Error(
      "A2A artifact path is forbidden or escapes the repository. Select a product file without credentials, runtime state or agent instructions.",
    )
}

export function validateA2aAllowedPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100)
    throw new Error("A2A artifacts require between 1 and 100 exact allowed paths.")
  for (const path of paths) assertA2aPath(path)
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw new Error("A2A allowed paths contain duplicate or case-colliding files. Select each product path once.")
  if (
    paths.some((path) =>
      paths.some((other) => path !== other && other.toLowerCase().startsWith(`${path.toLowerCase()}/`)),
    )
  )
    throw new Error("A2A allowed paths overlap as files and directories. Select independent product files.")
  return [...paths]
}

const path = z.string().superRefine((value, context) => {
  try {
    assertA2aPath(value)
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid artifact path." })
  }
})
export const a2aArtifactBindingSchema = z.strictObject({
  attemptId: z.string().min(1).max(200),
  requestSha256: digest,
  repositoryId: z.string().min(1).max(500),
  baseRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  baseFingerprint: digest,
  allowedPaths: z.array(path).min(1).max(100),
})
export type A2aArtifactBinding = z.infer<typeof a2aArtifactBindingSchema>

export const a2aArtifactManifestSchema = z.strictObject({
  version: z.literal(1),
  attemptId: z.string().min(1).max(200),
  requestSha256: digest,
  repositoryId: z.string().min(1).max(500),
  baseRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  files: z
    .array(
      z.strictObject({
        path,
        contentBase64: z.string().max(1_398_104).nullable(),
        sha256: digest.nullable(),
        executable: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
})
export type A2aArtifactManifest = z.infer<typeof a2aArtifactManifestSchema>

export const a2aArtifactJournalSchema = z
  .strictObject({
    version: z.literal(1),
    binding: a2aArtifactBindingSchema,
    manifest: a2aArtifactManifestSchema,
    manifestSha256: digest,
    before: z
      .array(z.strictObject({ path, sha256: digest.nullable(), mode: z.number().int().min(0).max(0o777).nullable() }))
      .min(1)
      .max(100),
    immutableFingerprint: digest,
    phase: z.enum(["prepared", "applying", "applied"]),
    resultingFingerprint: digest.optional(),
  })
  .superRefine((value, context) => {
    if (value.phase === "applied" && !value.resultingFingerprint)
      context.addIssue({
        code: "custom",
        path: ["resultingFingerprint"],
        message: "Applied artifacts require their resulting fingerprint.",
      })
  })
export type A2aArtifactJournal = z.infer<typeof a2aArtifactJournalSchema>
