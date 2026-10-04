import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkReleaseVersions, releaseManifests } from "./check-release-versions.mjs"

let root: string
async function json(path: string, contents: unknown) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(contents))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-release-alignment-"))
  await json("package.json", { version: "9.2.1-rc.4" })
  for (const path of releaseManifests) await json(path, { version: "9.2.1-rc.4" })
  await json("release-please-config.json", {
    packages: {
      ".": {
        "extra-files": releaseManifests.map((path) => ({ type: "json", path, jsonpath: "$.version" })),
      },
    },
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("release version gate", () => {
  it("accepts a synchronized future prerelease", async () => {
    await expect(checkReleaseVersions(root)).resolves.toBe("9.2.1-rc.4")
  })
  it("rejects a stale public plugin version with its path and repair instructions", async () => {
    await json("integrations/qwen-extension.json", { version: "0.3.0" })
    await expect(checkReleaseVersions(root)).rejects.toThrow(
      "integrations/qwen-extension.json: version=0.3.0; expected 9.2.1-rc.4",
    )
  })
  it("rejects missing future release automation even when current versions agree", async () => {
    await json("release-please-config.json", { packages: { ".": { "extra-files": [] } } })
    await expect(checkReleaseVersions(root)).rejects.toThrow(
      "integrations/.claude-plugin/plugin.json: missing version update",
    )
  })
})
