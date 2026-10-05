import { createHash } from "node:crypto"

const secretName = /(?:password|passwd|secret|token|(?:api|access|private)[_-]?key|credential|authorization|cookie)/i

/** Uses credential values only transiently; no environment or raw CLI response is persisted. */
export function sanitizeContainerText(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const secrets = Object.entries(env)
    .filter(([name, secret]) => secretName.test(name) && Boolean(secret))
    .flatMap(([, secret]) => [
      secret as string,
      encodeURIComponent(secret as string),
      JSON.stringify(secret).slice(1, -1),
    ])
    .sort((a, b) => b.length - a.length)
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    ["\n", "\r", "\t"].includes(character) ? character : "",
  )
  const reduced = text
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
      "[redacted private key]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[redacted authorization]")
    .replace(
      /([?&](?:key|sig|signature|code|auth|session|pwd|pass|[\w.-]*(?:token|secret|password|api[_-]?key|credential)[\w.-]*)=)[^\s&#"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:["']?)(?:[\w.-]*(?:password|passwd|secret|token|(?:api|access|private|signing|encryption|ssh)[_-]?key|credential|authorization|cookie)[\w.-]*)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted token]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk|xox[baprs]|npm|AKIA|ASIA)[-_]?[A-Za-z0-9_-]{16,})\b/g,
      "[redacted token]",
    )
    .replace(/\bya29\.[A-Za-z0-9_-]{16,}\b/g, "[redacted token]")
  const escaped = [...new Set(secrets)].map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  // A single replacement pass avoids recursively expanding redaction markers for short credentials.
  return escaped.length ? reduced.replace(new RegExp(escaped.join("|"), "g"), "[redacted]") : reduced
}

export function containerDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Log content is an untrusted symptom. Error words never establish a root cause by themselves. */
export function containerErrorEvidence(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(?:error|fatal|panic|exception|traceback|segmentation fault|out of memory)\b/i.test(line))
    .filter((line) => !/\b(?:0|zero|no|without)\s+errors?\b|\berror(?:s)?\s*[=:]\s*0\b/i.test(line))
    .map((line) => line.replace(/^\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?\s+/, "").trim())
    .filter(Boolean)
    .slice(-20)
}
