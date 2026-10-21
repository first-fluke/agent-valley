/** Maximum accepted webhook body size (1 MiB). */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576

export type BoundedBody = { ok: true; text: string } | { ok: false; status: 413 }

/**
 * Read a request body without buffering more than `maxBytes`.
 *
 * The previous `await request.text()` + length check buffered the whole body
 * first, so the limit could not prevent memory exhaustion. This reads the
 * stream chunk-by-chunk and aborts as soon as the cap is crossed.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 }
  if (!request.body) return { ok: true, text: "" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, status: 413 }
    }
    chunks.push(value)
  }

  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") }
}
