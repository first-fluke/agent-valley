import assert from "node:assert/strict"

const forbiddenFields = [
  "private",
  "workspaces",
  "scripts",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
]

/** The native driver's platform packages must be installed by npm, never bundled. */
export function nativeRuntimeDependencies(core) {
  const version = core?.dependencies?.["@libsql/client"]
  assert(
    typeof version === "string" && /^[~^<>=*v0-9][^:/\\]*$/.test(version.trim()),
    "Set dependencies.@libsql/client in packages/core/package.json to a published registry version range.",
  )
  return { "@libsql/client": version }
}

/** Check the standalone package without building, packing or installing it. */
export function assertCliPackageManifest(manifest, expectedRuntimeDependencies) {
  assert.equal(manifest.name, "agent-valley")
  assert.equal(manifest.type, "module")
  for (const field of forbiddenFields)
    assert(
      !Object.hasOwn(manifest, field),
      `Published package must omit ${field}; installation must not use workspace resolution or lifecycle hooks.`,
    )
  const dependencies = manifest.dependencies
  assert(
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies),
    "Published package must declare its native runtime dependencies.",
  )
  assert.deepEqual(
    Object.keys(dependencies).sort(),
    Object.keys(expectedRuntimeDependencies).sort(),
    "Published package must declare only the approved native runtime dependencies.",
  )
  for (const [name, version] of Object.entries(expectedRuntimeDependencies))
    assert(dependencies[name] === version, `Published dependency ${name} must match packages/core/package.json.`)
  assert(
    typeof manifest.engines?.node === "string" &&
      manifest.engines.node.trim() &&
      typeof manifest.engines?.bun === "string" &&
      manifest.engines.bun.trim(),
    "Document both Node.js and Bun runtime requirements.",
  )
}
