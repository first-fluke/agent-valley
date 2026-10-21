#!/usr/bin/env node
/**
 * Dependency-direction gate.
 *
 * checks:
 *   1. domain purity — domain/** must not import application/infrastructure.
 *   2. adapter isolation — adapter modules must not import application layers.
 *   3. no circular imports between production modules.
 *
 * Existing violations are frozen in scripts/import-rules.baseline.json so the
 * gate can land without a big-bang refactor; any NEW violation fails CI.
 * Remove baseline entries as the corresponding imports are fixed.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE_ROOTS = ["packages/core/src", "apps/cli/src", "apps/dashboard/src"]
const ADAPTER_FORBIDDEN = ["/orchestrator/", "/chief/"]
const DOMAIN_FORBIDDEN = [
  "/tracker/",
  "/workspace/",
  "/sessions/",
  "/observability/",
  "/config/",
  "/orchestrator/",
  "/chief/",
  "/relay/",
  "/agent-registry",
]

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, files)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) files.push(path)
  }
  return files
}

function resolveImport(fromFile, specifier) {
  let target
  if (specifier.startsWith(".")) {
    target = resolve(dirname(fromFile), specifier)
  } else if (specifier.startsWith("@agent-valley/core/")) {
    target = resolve(repositoryRoot, "packages/core/src", specifier.slice("@agent-valley/core/".length))
  } else if (specifier.startsWith("@/")) {
    target = resolve(repositoryRoot, "apps/dashboard/src", specifier.slice(2))
  } else {
    return null
  }
  return target.replaceAll(sep, "/")
}

function resolveFile(target) {
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Strongly connected components with more than one module (Tarjan). */
function findCycles(graph) {
  let index = 0
  const stack = []
  const onStack = new Set()
  const indices = new Map()
  const low = new Map()
  const cycles = []

  const strongConnect = (node) => {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)))
      }
    }

    if (low.get(node) !== indices.get(node)) return
    const component = []
    let current
    do {
      current = stack.pop()
      onStack.delete(current)
      component.push(current)
    } while (current !== node)
    if (component.length > 1) cycles.push(component.sort())
  }

  for (const node of graph.keys()) if (!indices.has(node)) strongConnect(node)
  return cycles
}

export function collectViolations(root = repositoryRoot) {
  const violations = new Set()
  const graph = new Map()
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = join(root, sourceRoot)
    let files
    try {
      files = walk(absoluteRoot)
    } catch {
      continue
    }
    for (const file of files) {
      const normalizedFile = file.replaceAll(sep, "/")
      const content = readFileSync(file, "utf8")
      for (const match of content.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2]
        if (!specifier) continue
        const target = resolveImport(file, specifier)
        if (!target) continue
        const resolvedTarget = resolveFile(target)
        if (resolvedTarget) {
          const from = relative(root, file).replaceAll(sep, "/")
          const to = relative(root, resolvedTarget).replaceAll(sep, "/")
          if (!graph.has(from)) graph.set(from, [])
          graph.get(from).push(to)
        }
        const targetFromRoot = relative(root, target).replaceAll(sep, "/")

        if (
          normalizedFile.includes("/domain/") &&
          DOMAIN_FORBIDDEN.some((segment) => targetFromRoot.includes(segment))
        ) {
          violations.add(`domain-purity\t${relative(root, file)}\t${targetFromRoot}`)
        }
        if (
          normalizedFile.includes("/adapters/") &&
          ADAPTER_FORBIDDEN.some((segment) => targetFromRoot.includes(segment))
        ) {
          violations.add(`adapter-isolation\t${relative(root, file)}\t${targetFromRoot}`)
        }
      }
    }
  }
  for (const cycle of findCycles(graph)) violations.add(`cycle\t${cycle.join("|")}`)
  return [...violations].sort()
}

export function loadBaseline(path = join(repositoryRoot, "scripts/import-rules.baseline.json")) {
  try {
    return new Set(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return new Set()
  }
}

function main() {
  const violations = collectViolations()
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(
      join(repositoryRoot, "scripts/import-rules.baseline.json"),
      `${JSON.stringify(violations, null, 2)}\n`,
    )
    console.log(`Wrote ${violations.length} baseline entr(ies).`)
    return
  }

  const baseline = loadBaseline()
  const added = violations.filter((violation) => !baseline.has(violation))
  const fixed = [...baseline].filter((entry) => !violations.includes(entry)).sort()

  for (const entry of fixed) console.log(`fixed (remove from baseline): ${entry}`)
  if (added.length === 0) {
    console.log(`Import rules OK (${violations.length} known exception(s), 0 new).`)
    return
  }

  for (const entry of added) console.error(`new violation: ${entry}`)
  console.error(
    `\n${added.length} new import-rule violation(s).\n` +
      "  Fix: depend on domain/ports from application code, and never import\n" +
      "  application modules (orchestrator/chief/workspace) from adapters.\n" +
      "  Location: scripts/check-import-rules.mjs",
  )
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
