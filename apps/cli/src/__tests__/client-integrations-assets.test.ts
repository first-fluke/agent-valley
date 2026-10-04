import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, test } from "vitest"
import { installClientIntegrations } from "../client-integrations"
import { clientSkillAssetCandidates, copyClientSkillAsset, loadClientSkillAsset } from "../client-integrations-assets"

let root: string
const skill = "---\nname: av\ndescription: Manage AV missions.\n---\nCheck AGENT_VALLEY_MANAGED_RUN.\n"

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-client-assets-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test("source launcher resolves the product SSOT and package files include dist assets", async () => {
  const checkout = join(root, "checkout with spaces")
  const source = join(checkout, "integrations/skills/av/SKILL.md")
  await put(source, skill)
  const candidates = clientSkillAssetCandidates(
    pathToFileURL(join(checkout, "apps/cli/src/client-integrations.ts")).href,
  )
  expect((await loadClientSkillAsset(candidates)).path).toBe(source)
  const manifest = JSON.parse(await readFile(resolve("apps/cli/package.json"), "utf8"))
  expect(manifest.files).toContain("dist")
})

test("asset copy hook produces a usable packaged skill in an isolated distribution fixture", async () => {
  const source = join(root, "source")
  await put(join(source, "SKILL.md"), skill)
  const distribution = join(root, "npm package/dist")
  const asset = await copyClientSkillAsset(distribution, source)
  const candidates = clientSkillAssetCandidates(pathToFileURL(join(distribution, "index.js")).href)
  const loaded = await loadClientSkillAsset(candidates)
  expect(loaded.path).toBe(asset)
  expect(loaded.content).toBe(skill)
  const workspace = join(root, "repository")
  await mkdir(workspace)
  await installClientIntegrations(workspace, { sourceSkillRoot: dirname(loaded.path) })
  expect(await readFile(join(workspace, ".agents/skills/av/SKILL.md"), "utf8")).toBe(skill)
})

test("packaged asset takes precedence over an unrelated source-relative path", async () => {
  const candidates = clientSkillAssetCandidates(
    pathToFileURL(join(root, "node_modules/agent-valley/dist/index.js")).href,
  )
  await put(candidates[0] as string, skill)
  await put(candidates[1] as string, `${skill}Unexpected fallback.\n`)
  expect((await loadClientSkillAsset(candidates)).content).toBe(skill)
})

test("a corrupt package asset fails without silently substituting another definition", async () => {
  const candidates = clientSkillAssetCandidates(
    pathToFileURL(join(root, "node_modules/agent-valley/dist/index.js")).href,
  )
  await put(candidates[0] as string, "broken")
  await put(candidates[1] as string, skill)
  await expect(loadClientSkillAsset(candidates)).rejects.toThrow("is invalid")
  await expect(loadClientSkillAsset([join(root, "missing/SKILL.md")])).rejects.toThrow(
    "complete Agent Valley checkout or CLI package",
  )
})
