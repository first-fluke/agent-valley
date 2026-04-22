/**
 * Secret masking helpers for the final preview.
 *
 * `maskApiKey` keeps the prefix/suffix for operator recognition while
 * redacting the middle. `maskSecret` is stricter — for high-entropy
 * tokens (GitHub PAT, webhook secrets) we redact everything except a
 * short tail so operators can still diff values across environments.
 */

export function maskApiKey(key: string): string {
  if (key.length <= 12) return "****"
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}

export function maskSecret(value: string): string {
  if (!value) return ""
  if (value.length <= 8) return "****"
  return `****${value.slice(-4)}`
}
