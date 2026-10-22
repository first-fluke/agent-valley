import { z } from "zod"
import { type A2aPart, type A2aSendResponse, a2aSendResponseSchema } from "../sessions/adapters/a2a-contracts"
import { clearedGitEnvironment } from "../util/git-environment"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import { runCommand } from "../workspace/worktree-lifecycle"
import {
  A2A_ARTIFACT_MAX_FILE_BYTES,
  A2A_ARTIFACT_MAX_TOTAL_BYTES,
  type A2aArtifactBinding,
  type A2aArtifactJournal,
  a2aArtifactBindingSchema,
  a2aArtifactJournalSchema,
  a2aArtifactManifestSchema,
  validateA2aAllowedPaths,
} from "./a2a-artifact-contract"
import {
  artifactDigest,
  artifactImage,
  artifactRoot,
  desiredArtifact,
  sameArtifact,
  writeArtifact,
} from "./a2a-artifact-files"

export {
  type A2aArtifactBinding,
  type A2aArtifactJournal,
  type A2aArtifactManifest,
  a2aArtifactBindingSchema,
  a2aArtifactJournalSchema,
  assertA2aPath,
  validateA2aAllowedPaths,
} from "./a2a-artifact-contract"

export interface A2aArtifactHooks {
  load(): Promise<A2aArtifactJournal | undefined>
  save(journal: A2aArtifactJournal): Promise<void>
}

const envelopeSchema = z.strictObject({ agentValleyArtifact: a2aArtifactManifestSchema })
function manifestFor(binding: A2aArtifactBinding, input: A2aSendResponse) {
  const response = a2aSendResponseSchema.parse(input)
  if (response.task && response.task.status.state !== "TASK_STATE_COMPLETED")
    throw new Error("A2A artifacts require a completed remote task. Reconcile the runtime before applying changes.")
  const parts: A2aPart[] = [
    ...(response.message?.parts ?? []),
    ...(response.task?.status.message?.parts ?? []),
    ...(response.task?.artifacts?.flatMap((artifact) => artifact.parts) ?? []),
  ]
  if (parts.some((part) => Object.hasOwn(part, "url") || Object.hasOwn(part, "raw")))
    throw new Error(
      "A2A artifacts must use one inline data manifest. Remote URLs and raw attachments are not accepted.",
    )
  const data = parts.filter((part) => Object.hasOwn(part, "data"))
  if (data.length !== 1)
    throw new Error(
      "A2A artifacts require exactly one inline data manifest. Return the bound agentValleyArtifact envelope.",
    )
  const manifest = envelopeSchema.parse(data[0]?.data).agentValleyArtifact
  for (const key of ["attemptId", "requestSha256", "repositoryId", "baseRevision"] as const)
    if (manifest[key] !== binding[key])
      throw new Error(
        `A2A artifact ${key} differs from the saved request. Preserve the rejected response and reconcile it.`,
      )
  validateA2aAllowedPaths(manifest.files.map((file) => file.path))
  let total = 0
  for (const file of manifest.files) {
    if (!binding.allowedPaths.includes(file.path))
      throw new Error("A2A artifact path was not explicitly allowed. Return only the saved product paths.")
    if (file.contentBase64 === null || file.sha256 === null) {
      if (file.contentBase64 !== null || file.sha256 !== null || file.executable)
        throw new Error("A2A deletion requires null content and SHA256 without executable mode.")
      continue
    }
    const bytes = Buffer.from(file.contentBase64, "base64")
    if (bytes.toString("base64") !== file.contentBase64 || bytes.length > A2A_ARTIFACT_MAX_FILE_BYTES)
      throw new Error("A2A artifact content must be canonical base64 of at most 1 MiB.")
    if (artifactDigest(bytes) !== file.sha256)
      throw new Error("A2A artifact SHA256 does not match its bytes. Preserve the rejected response before retrying.")
    total += bytes.length
    if (total > A2A_ARTIFACT_MAX_TOTAL_BYTES)
      throw new Error("A2A artifacts exceed the 4 MiB total limit. Return a smaller bounded manifest.")
  }
  return manifest
}

async function assertHead(root: string, revision: string): Promise<void> {
  const result = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env: clearedGitEnvironment })
  if (result.exitCode !== 0 || result.stdout.trim() !== revision)
    throw new Error(
      "A2A artifact repository HEAD differs from the saved base revision. Restore the selected repository before resuming.",
    )
}

async function inspectJournal(root: string, journal: A2aArtifactJournal, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await assertHead(root, journal.binding.baseRevision)
  signal?.throwIfAborted()
  const excluded = new Set(journal.manifest.files.map((file) => file.path))
  const immutableFingerprint = await fingerprintWorkspace(root, excluded)
  signal?.throwIfAborted()
  if (immutableFingerprint !== journal.immutableFingerprint)
    throw new Error(
      "Repository files outside the A2A manifest changed. Stop concurrent writers and reconcile the delivery.",
    )
  for (const [index, file] of journal.manifest.files.entries()) {
    const original = journal.before[index]
    if (!original || original.path !== file.path || (original.sha256 === null) !== (original.mode === null))
      throw new Error("Saved A2A artifact journal has invalid original file evidence. Restore its original receipt.")
    const current = await artifactImage(root, file.path)
    signal?.throwIfAborted()
    const desired = desiredArtifact(file)
    if (!sameArtifact(current, desired) && (journal.phase === "applied" || !sameArtifact(current, original)))
      throw new Error(
        "A2A artifact target changed outside its original or desired bytes and mode. Preserve the journal and reconcile it.",
      )
  }
}

/** Apply validated inline files with a durable recovery barrier before any product mutation. */
export async function applyA2aArtifacts(
  path: string,
  input: A2aArtifactBinding,
  response: A2aSendResponse,
  hooks: A2aArtifactHooks,
  signal?: AbortSignal,
): Promise<{ fingerprint: string; manifestSha256: string; paths: string[] }> {
  signal?.throwIfAborted()
  const binding = a2aArtifactBindingSchema.parse(input)
  validateA2aAllowedPaths(binding.allowedPaths)
  const root = await artifactRoot(path)
  signal?.throwIfAborted()
  const manifest = manifestFor(binding, response)
  const manifestSha256 = artifactDigest(JSON.stringify(manifest))
  const paths = manifest.files.map((file) => file.path)
  const saved = await hooks.load()
  signal?.throwIfAborted()
  let journal: A2aArtifactJournal
  if (saved) {
    journal = a2aArtifactJournalSchema.parse(saved)
    if (
      JSON.stringify(journal.binding) !== JSON.stringify(binding) ||
      journal.manifestSha256 !== manifestSha256 ||
      artifactDigest(JSON.stringify(journal.manifest)) !== manifestSha256 ||
      journal.before.length !== manifest.files.length
    )
      throw new Error(
        "Saved A2A artifact journal belongs to another request or manifest. Preserve it and reconcile before resuming.",
      )
  } else {
    await assertHead(root, binding.baseRevision)
    signal?.throwIfAborted()
    const baseFingerprint = await fingerprintWorkspace(root)
    signal?.throwIfAborted()
    if (baseFingerprint !== binding.baseFingerprint)
      throw new Error(
        "A2A artifact workspace differs from the saved base fingerprint. Stop concurrent writers before applying changes.",
      )
    const before = await Promise.all(paths.map((name) => artifactImage(root, name)))
    signal?.throwIfAborted()
    journal = {
      version: 1,
      binding,
      manifest,
      manifestSha256,
      before,
      immutableFingerprint: await fingerprintWorkspace(root, new Set(paths)),
      phase: "prepared",
    }
    signal?.throwIfAborted()
    const currentBase = await fingerprintWorkspace(root)
    signal?.throwIfAborted()
    if (currentBase !== binding.baseFingerprint)
      throw new Error("A2A artifact base changed during preparation. Stop concurrent writers before applying files.")
    await hooks.save(a2aArtifactJournalSchema.parse(journal))
    signal?.throwIfAborted()
  }
  await inspectJournal(root, journal, signal)
  signal?.throwIfAborted()
  if (journal.phase !== "applied") {
    journal.phase = "applying"
    await hooks.save(a2aArtifactJournalSchema.parse(journal))
    signal?.throwIfAborted()
    // Persistence hooks can yield; recheck every target before the first write.
    await inspectJournal(root, journal, signal)
    signal?.throwIfAborted()
    for (const file of manifest.files) {
      const current = await artifactImage(root, file.path)
      signal?.throwIfAborted()
      const original = journal.before.find((entry) => entry.path === file.path)
      if (!original || (!sameArtifact(current, original) && !sameArtifact(current, desiredArtifact(file))))
        throw new Error(
          "A2A artifact target changed before its write. Preserve the journal and stop concurrent writers.",
        )
      if (!sameArtifact(current, desiredArtifact(file))) {
        signal?.throwIfAborted()
        await writeArtifact(root, file, current, signal)
        signal?.throwIfAborted()
      }
    }
    await inspectJournal(root, journal, signal)
    signal?.throwIfAborted()
    for (const file of manifest.files) {
      const current = await artifactImage(root, file.path)
      signal?.throwIfAborted()
      if (!sameArtifact(current, desiredArtifact(file)))
        throw new Error(
          "Applied A2A artifact differs from its validated bytes or mode. Preserve the journal for recovery.",
        )
    }
    journal.resultingFingerprint = await fingerprintWorkspace(root)
    signal?.throwIfAborted()
    journal.phase = "applied"
    await hooks.save(a2aArtifactJournalSchema.parse(journal))
    signal?.throwIfAborted()
  }
  await inspectJournal(root, journal, signal)
  signal?.throwIfAborted()
  const fingerprint = await fingerprintWorkspace(root)
  signal?.throwIfAborted()
  if (fingerprint !== journal.resultingFingerprint)
    throw new Error(
      "A2A artifact workspace changed after application. Rerun trusted verification after reconciling the journal.",
    )
  return { fingerprint, manifestSha256, paths }
}
