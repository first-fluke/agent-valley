import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  copyPluginLicenseAsset,
  copyPluginManifestAsset,
  loadPluginLicenseAsset,
  loadPluginManifestAsset,
  pluginLicenseAssetCandidates,
  pluginManifestAssetCandidates,
} from "../plugin-assets"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("AV plugin metadata assets", () => {
  it("preserves the canonical license in the installed CLI assets without a source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-plugin-license-"))
    temporary.push(root)
    const source = await loadPluginLicenseAsset()
    expect(source.content).toBe(await readFile(new URL("../../../../LICENSE", import.meta.url), "utf8"))
    const copied = await copyPluginLicenseAsset(root)
    expect(copied).toBe(join(root, "assets/LICENSE"))
    const candidates = pluginLicenseAssetCandidates(pathToFileURL(join(root, "index.js")).href)
    expect(candidates[0]).toBe(copied)
    expect((await loadPluginLicenseAsset([candidates[0] as string])).content).toBe(source.content)
  })

  it("falls back from a missing license and rejects unreadable or empty license assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-plugin-license-"))
    temporary.push(root)
    const missing = join(root, "missing")
    const source = await loadPluginLicenseAsset()
    expect((await loadPluginLicenseAsset([missing, source.path])).content).toBe(source.content)
    await expect(loadPluginLicenseAsset([missing])).rejects.toThrow("restore integrations/LICENSE")
    const empty = join(root, "empty")
    await writeFile(empty, " \n")
    await expect(loadPluginLicenseAsset([empty, source.path])).rejects.toThrow("is empty")
    await mkdir(join(root, "directory"))
    await expect(loadPluginLicenseAsset([join(root, "directory")])).rejects.toThrow("Cannot read AV license")
  })

  it("copies canonical metadata into the installed CLI asset location", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-plugin-assets-"))
    temporary.push(root)
    const source = await loadPluginManifestAsset()
    const copied = await copyPluginManifestAsset(root)
    expect(copied).toBe(join(root, "assets/plugin.json"))
    expect(await readFile(copied, "utf8")).toBe(await readFile(source.path, "utf8"))
    const candidates = pluginManifestAssetCandidates(pathToFileURL(join(root, "index.js")).href)
    expect(candidates[0]).toBe(copied)
    expect((await loadPluginManifestAsset(candidates)).manifest).toEqual(source.manifest)
  })

  it("falls back from a missing packaged asset and rejects invalid metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-plugin-assets-"))
    temporary.push(root)
    const missing = join(root, "missing.json")
    const source = await loadPluginManifestAsset()
    expect((await loadPluginManifestAsset([missing, source.path])).manifest.name).toBe("av")
    const invalid = join(root, "invalid.json")
    await writeFile(invalid, JSON.stringify({ ...source.manifest, unexpected: "unsupported portable field" }))
    await expect(loadPluginManifestAsset([invalid])).rejects.toThrow("metadata")
    await writeFile(invalid, "not JSON")
    await expect(loadPluginManifestAsset([invalid])).rejects.toThrow("invalid")
    await expect(loadPluginManifestAsset([missing])).rejects.toThrow("missing")
    const directory = join(root, "directory.json")
    await mkdir(directory)
    await expect(loadPluginManifestAsset([directory])).rejects.toThrow("Cannot read")
  })
})
