import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { buildAgentEnv } from "@agent-valley/core/sessions/base-session"
import { resolveBinaryPath } from "@agent-valley/core/sessions/sandbox-binary"
import { type AuthProbeOptions, type AuthProbeResult, probeNativeCli } from "./agent-discovery"

const MAX_OUTPUT_BYTES = 2_097_152
const PROBE_TIMEOUT_MS = 15_000
const MODEL_ID = /^[\w.:-]+\/[\w./:-]+$/
type JsonRecord = Record<string, unknown>

interface CatalogModel {
  id: string
  metadata: JsonRecord
}

export interface FreeModelDiscoveryDeps {
  env: NodeJS.ProcessEnv
  resolveBinary: (binary: string) => string | null
  probe: (binary: string, args: readonly string[], options: AuthProbeOptions) => Promise<AuthProbeResult>
  readState: (path: string) => string | undefined
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

/** Native --verbose emits one ID line followed by one pretty-printed JSON object. */
export function parseOpenCodeCatalog(output: string): CatalogModel[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error("OpenCode model catalog exceeded the limit")
  const lines = stripVTControlCharacters(output).trim().split(/\r?\n/)
  const result: CatalogModel[] = []
  for (let index = 0; index < lines.length; index++) {
    const id = lines[index]?.trim() ?? ""
    if (!id || id === "Models cache refreshed") continue
    if (!MODEL_ID.test(id) || lines[index + 1]?.trim() !== "{") {
      throw new Error("Unsupported OpenCode model catalog format")
    }
    const start = ++index
    // Pretty-printed JSON closes its root object at column zero.
    while (index < lines.length && lines[index] !== "}") index++
    if (index >= lines.length) throw new Error("Incomplete OpenCode model catalog")
    const metadata = record(JSON.parse(lines.slice(start, index + 1).join("\n")))
    if (`${metadata.providerID}/${metadata.id}` !== id) throw new Error("Inconsistent OpenCode model identity")
    result.push({ id, metadata })
  }
  return result
}

function zeroPrice(value: unknown): boolean {
  const price = record(value)
  const cache = record(price.cache)
  return price.input === 0 && price.output === 0 && cache.read === 0 && cache.write === 0
}

function isFreeActorModel({ metadata }: CatalogModel): boolean {
  // OpenCode Go zero-price entries may be included in a paid subscription.
  if (metadata.providerID !== "opencode" || metadata.status !== "active") return false
  const capabilities = record(metadata.capabilities)
  if (
    capabilities.toolcall !== true ||
    record(capabilities.input).text !== true ||
    record(capabilities.output).text !== true
  )
    return false
  const cost = record(metadata.cost)
  if (!zeroPrice(cost)) return false
  if (cost.tiers !== undefined && (!Array.isArray(cost.tiers) || !cost.tiers.every(zeroPrice))) return false
  return cost.experimentalOver200K === undefined || zeroPrice(cost.experimentalOver200K)
}

/** Use only a configured model or a recent model present before catalog refresh. */
export function openCodeDefaultModel(config: unknown, state: unknown, catalog: CatalogModel[]): string | undefined {
  const settings = record(config)
  const defaultAgent = typeof settings.default_agent === "string" ? settings.default_agent : "build"
  const agentModel = record(record(settings.agent)[defaultAgent]).model
  const configured = agentModel ?? settings.model
  if (typeof configured === "string") return MODEL_ID.test(configured) ? configured : undefined
  if (configured !== undefined) return undefined
  const available = new Set(catalog.map((model) => model.id))
  const recent = record(state).recent
  if (!Array.isArray(recent)) return undefined
  for (const entry of recent) {
    const model = record(entry)
    if (typeof model.providerID !== "string" || typeof model.modelID !== "string") continue
    const id = `${model.providerID}/${model.modelID}`
    if (MODEL_ID.test(id) && available.has(id)) return id
  }
  // Native internal priorities vary by CLI version; leave their identity unresolved.
  return undefined
}

function readState(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES) return undefined
    const content = readFileSync(path, "utf8")
    return Buffer.byteLength(content) <= MAX_OUTPUT_BYTES ? content : undefined
  } catch {
    return undefined
  }
}

export async function discoverFreeModels(
  agentType: string,
  workspacePath: string,
  signal?: AbortSignal,
  overrides: Partial<FreeModelDiscoveryDeps> = {},
): Promise<{ models: string[]; defaultModel?: string }> {
  signal?.throwIfAborted()
  if (agentType !== "opencode") return { models: [] }
  const deps: FreeModelDiscoveryDeps = {
    env: process.env,
    resolveBinary: resolveBinaryPath,
    probe: probeNativeCli,
    readState,
    ...overrides,
  }
  const env = buildAgentEnv(agentType, {}, deps.env)
  if (["1", "true"].includes(env.OPENCODE_DISABLE_FREE_MODELS ?? "")) return { models: [] }
  try {
    const binary = deps.resolveBinary("opencode")
    if (!binary) return { models: [] }
    const probe = async (args: readonly string[]): Promise<string> => {
      const controller = new AbortController()
      const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      try {
        const result = await deps.probe(binary, args, {
          env,
          cwd: workspacePath,
          timeoutMs: PROBE_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal: probeSignal,
        })
        probeSignal.throwIfAborted()
        if (
          result.exitCode !== 0 ||
          Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES
        )
          throw new Error("OpenCode model discovery could not complete")
        return result.stdout
      } finally {
        clearTimeout(timer)
      }
    }
    let state: unknown
    try {
      const home = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state")
      const content = deps.readState(join(home, "opencode", "model.json"))
      state = content && Buffer.byteLength(content) <= MAX_OUTPUT_BYTES ? JSON.parse(content) : undefined
    } catch {
      state = undefined
    }
    const [before, config] = await Promise.allSettled([probe(["models", "--verbose"]), probe(["debug", "config"])])
    signal?.throwIfAborted()
    let defaultModel: string | undefined
    if (config.status === "fulfilled") {
      try {
        const catalog = before.status === "fulfilled" ? parseOpenCodeCatalog(before.value) : []
        defaultModel = openCodeDefaultModel(JSON.parse(config.value), state, catalog)
      } catch {
        // Do not attribute an uncertain native default to a particular failed model.
      }
    }
    const refresh = !["1", "true"].includes(env.OPENCODE_DISABLE_MODELS_FETCH ?? "")
    const catalog = refresh
      ? parseOpenCodeCatalog(await probe(["models", "--verbose", "--refresh"]))
      : before.status === "fulfilled"
        ? parseOpenCodeCatalog(before.value)
        : []
    signal?.throwIfAborted()
    return {
      models: [...new Set(catalog.filter(isFreeActorModel).map((model) => model.id))],
      ...(defaultModel && { defaultModel }),
    }
  } catch {
    signal?.throwIfAborted()
    // Native output/config can contain provider credentials; never include it in diagnostics.
    return { models: [] }
  }
}
