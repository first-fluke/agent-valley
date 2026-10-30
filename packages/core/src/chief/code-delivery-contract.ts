import { z } from "zod"

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export function codeDeliveryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || "\\:*?[]{}".includes(character),
    ) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !path.split("/").some((part) => [".git", ".agent-valley", ".agents", "node_modules"].includes(part)) &&
    !path.split("/").some((part) => /^\.env(?:\.|$)|^(?:av\.yaml|credentials(?:\..*)?|.*\.(?:pem|key))$/i.test(part))
  )
}

export const codeDeliveryPolicySchema = z.strictObject({
  branch: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
  remote: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  paths: z
    .array(
      z.string().refine(codeDeliveryPath, "Select exact product paths; private/runtime paths cannot be delivered."),
    )
    .min(1)
    .max(100)
    .refine((paths) => new Set(paths).size === paths.length, "Select each delivery path once."),
  message: z.string().trim().min(1).max(8_000),
  baseSha: sha,
})

export const codeDeliverySchema = z
  .strictObject({
    policy: codeDeliveryPolicySchema,
    phase: z.enum(["pending", "prepared", "committed", "pushed", "unchanged", "blocked"]),
    attempts: z.number().int().min(0).max(3),
    nonce: z.uuid().optional(),
    treeSha: sha.optional(),
    patchSha256: digest.optional(),
    verifiedFingerprint: digest.optional(),
    commitSha: sha.optional(),
    nextRunAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime(),
    error: z.string().max(8_000).optional(),
  })
  .superRefine((delivery, context) => {
    if (
      ["prepared", "committed", "pushed"].includes(delivery.phase) &&
      (!delivery.nonce || !delivery.treeSha || !delivery.patchSha256 || !delivery.verifiedFingerprint)
    )
      context.addIssue({ code: "custom", message: "Prepared code delivery requires its verified content bindings." })
    if (["committed", "pushed"].includes(delivery.phase) && !delivery.commitSha)
      context.addIssue({ code: "custom", message: "Committed code delivery requires its exact commit SHA." })
  })

export type CodeDeliveryPolicy = z.infer<typeof codeDeliveryPolicySchema>
export type CodeDelivery = z.infer<typeof codeDeliverySchema>

export function pendingCodeDelivery(mission: { codeDelivery?: CodeDelivery }): boolean {
  return !!mission.codeDelivery && ["pending", "prepared", "committed"].includes(mission.codeDelivery.phase)
}

export function successfulCodeDelivery(mission: { codeDelivery?: CodeDelivery }): boolean {
  return !mission.codeDelivery || ["pushed", "unchanged"].includes(mission.codeDelivery.phase)
}
