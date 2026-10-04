import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AV_VERSION, readPackageVersion } from "./version"

let root: string
let metadata: URL
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-release-version-"))
  metadata = pathToFileURL(join(root, "package.json"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("release identity", () => {
  it("reads future and prerelease package metadata without a code version pin", async () => {
    await writeFile(metadata, JSON.stringify({ version: "9.2.1-rc.4" }))
    expect(readPackageVersion(metadata)).toBe("9.2.1-rc.4")
    expect(AV_VERSION).toBe(readPackageVersion(new URL("../package.json", import.meta.url)))
  })
  it.each([{}, { version: "" }, { version: " " }, { version: 1 }, null])(
    "rejects package metadata with no usable version: %j",
    async (contents) => {
      await writeFile(metadata, JSON.stringify(contents))
      expect(() => readPackageVersion(metadata)).toThrow("Restore package.json or reinstall Agent Valley")
    },
  )
})
