import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { distributionManifest } from "../apps/cli/src/npm-distribution"
import { assertCliPackageManifest, nativeRuntimeDependencies } from "./cli-package-manifest.mjs"

const engines = { node: ">=26.10.0", bun: ">=1.4.2" }
const core = { dependencies: { "@libsql/client": "^0.18.0" } }
const expected = nativeRuntimeDependencies(core)
const source = {
  name: "agent-valley",
  version: "2.3.1",
  type: "module",
  scripts: { postinstall: "do-not-run" },
  dependencies: { "@agent-valley/core": "workspace:*", commander: "^15.0.0" },
}
const manifest = () => distributionManifest(source, engines, core)

describe("standalone CLI manifest verification", () => {
  it("accepts the actual pure manifest generator's native dependency contract", () => {
    expect(() => assertCliPackageManifest(manifest(), expected)).not.toThrow()
    const metadata = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
    const actualCore = metadata("../packages/core/package.json")
    expect(() =>
      assertCliPackageManifest(
        distributionManifest(metadata("../apps/cli/package.json"), metadata("../package.json").engines, actualCore),
        nativeRuntimeDependencies(actualCore),
      ),
    ).not.toThrow()
  })

  it.each([
    undefined,
    {},
    { ...expected, commander: "^15.0.0" },
    { ...expected, "@agent-valley/core": "workspace:*" },
    { "@libsql/client": "workspace:*" },
    { "@libsql/client": "^0.19.0" },
  ])("rejects missing, extra or mismatched dependencies", (dependencies) => {
    expect(() => assertCliPackageManifest({ ...manifest(), dependencies }, expected)).toThrow()
  })

  it.each([
    ["private", true],
    ["workspaces", ["packages/*"]],
    ["scripts", { postinstall: "do-not-run" }],
    ["devDependencies", { tool: "workspace:*" }],
    ["optionalDependencies", { tool: "workspace:*" }],
    ["peerDependencies", { tool: "workspace:*" }],
    ["peerDependenciesMeta", { tool: { optional: true } }],
    ["bundleDependencies", ["tool"]],
    ["bundledDependencies", ["tool"]],
    ["overrides", { "@libsql/client": "file:../local" }],
    ["resolutions", { "@libsql/client": "workspace:*" }],
  ])("rejects inherited %s metadata", (field, value) => {
    expect(() => assertCliPackageManifest({ ...manifest(), [field as string]: value }, expected)).toThrow(String(field))
  })

  it.each(["workspace:*", "file:../driver", "link:../driver", "https://example.test/driver.tgz", "latest", ""])(
    "refuses to prime dependencies from nonregistry version %s",
    (version) => {
      expect(() => nativeRuntimeDependencies({ dependencies: { "@libsql/client": version } })).toThrow("registry")
    },
  )

  it.each([
    { name: "wrong-package" },
    { type: "commonjs" },
    { engines: { node: engines.node } },
    { engines: { bun: engines.bun } },
  ])("retains package identity and engine gates", (patch) => {
    expect(() => assertCliPackageManifest({ ...manifest(), ...patch }, expected)).toThrow()
  })
})
