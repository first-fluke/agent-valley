import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  type MetricSourceAdapter,
  MetricSourceError,
  type MetricSourceRequest,
  type SourceMetricObservation,
  sourceMetricObservationSchema,
} from "./metric-source-policy"

export const MAX_METRIC_RESPONSE_BYTES = 2_000_000
export function metricSourceEnvironment(request: MetricSourceRequest, name: string | undefined): string {
  if (!name || !request.env[name]?.trim())
    throw new MetricSourceError(
      "Metric source credentials or endpoint are unavailable. Set its configured environment variables and resume.",
      true,
    )
  return request.env[name]?.trim() as string
}
export async function readMetricJson(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new MetricSourceError(
      `Metric provider returned HTTP ${response.status}. Check its credentials, permissions, rate limit and endpoint, then resume.`,
      [401, 403, 408, 429].includes(response.status) || response.status >= 500,
    )
  if (Number(response.headers.get("content-length")) > MAX_METRIC_RESPONSE_BYTES)
    throw new MetricSourceError("Metric response exceeds 2 MB. Configure a bounded metric endpoint.")
  if (!response.body)
    throw new MetricSourceError("Metric provider returned no JSON body. Configure a measured metric endpoint.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_METRIC_RESPONSE_BYTES)
        throw new MetricSourceError("Metric response exceeds 2 MB. Configure a bounded metric endpoint.")
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch (error) {
    if (error instanceof MetricSourceError) throw error
    throw new MetricSourceError("Metric provider did not return valid JSON. Check the configured endpoint and paths.")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function valueAt(json: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    return (value as Record<string, unknown>)[key]
  }, json)
}
function observation(json: unknown, request: MetricSourceRequest): SourceMetricObservation {
  const source = request.source
  const result = sourceMetricObservationSchema.safeParse({
    value: valueAt(json, source.value_path),
    timestamp: valueAt(json, source.timestamp_path),
    unit: valueAt(json, source.unit_path),
    window:
      source.window_start_path && source.window_end_path
        ? {
            start: valueAt(json, source.window_start_path),
            end: valueAt(json, source.window_end_path),
          }
        : undefined,
  })
  if (!result.success)
    throw new MetricSourceError(
      "Metric source lacks a finite value, unit, timestamp or valid measurement window. Correct its JSON paths and publish actual observations.",
    )
  return result.data
}
export const httpJsonMetricAdapter: MetricSourceAdapter = {
  async collect(request) {
    let endpoint: URL
    try {
      endpoint = new URL(metricSourceEnvironment(request, request.source.url_env))
    } catch (error) {
      if (error instanceof MetricSourceError) throw error
      throw new MetricSourceError(
        "Metric endpoint must be an HTTPS URL, or HTTP on localhost. Correct the configured environment variable.",
      )
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && local))
    )
      throw new MetricSourceError(
        "Metric endpoint must be HTTPS without embedded credentials, or HTTP on localhost. Keep tokens in token_env.",
      )
    const token = request.source.token_env ? metricSourceEnvironment(request, request.source.token_env) : undefined
    return observation(
      await readMetricJson(
        await request.fetch(endpoint.href, {
          method: "GET",
          headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: request.signal,
          redirect: "error",
        }),
      ),
      request,
    )
  },
}
export const jsonFileMetricAdapter: MetricSourceAdapter = {
  async collect(request) {
    const root = await realpath(request.repositoryRoot)
    const name = request.source.file
    if (!name || isAbsolute(name))
      throw new MetricSourceError(
        "Metric file must be relative to the source repository. Set chief.metric_sources.sources[].file in av.yaml.",
      )
    const path = resolve(root, name)
    const within = relative(root, path)
    if (!within || within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within))
      throw new MetricSourceError("Metric file escapes the source repository. Choose a repository-relative JSON file.")
    let current = root
    for (const part of within.split(sep)) {
      current = resolve(current, part)
      if ((await lstat(current)).isSymbolicLink())
        throw new MetricSourceError(
          "Metric file and parent directories must not be symlinks. Choose a regular JSON file inside the source repository.",
        )
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_METRIC_RESPONSE_BYTES || (await realpath(path)) !== path)
        throw new MetricSourceError(
          "Metric file must be a regular JSON file of at most 2 MB inside the source repository.",
        )
      const bytes = await file.readFile()
      if (bytes.byteLength > MAX_METRIC_RESPONSE_BYTES)
        throw new MetricSourceError("Metric file exceeds 2 MB. Reduce the source export before resuming.")
      return observation(JSON.parse(bytes.toString("utf8")) as unknown, request)
    } finally {
      await file.close()
    }
  },
}
