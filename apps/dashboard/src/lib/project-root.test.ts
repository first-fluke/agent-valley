import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { resolveProjectRoot } from "./project-root"

const tempDirs: string[] = []

describe("resolveProjectRoot", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true })
      }),
    )
  })

  test("walks up from standalone dashboard path to find av.yaml", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "av-bootstrap-"))
    tempDirs.push(root)

    await writeFile(path.join(root, "av.yaml"), "linear:\n  team_id: TEST\n")

    const standaloneDashboardDir = path.join(root, "apps", "dashboard", ".next", "standalone", "apps", "dashboard")
    await mkdir(standaloneDashboardDir, { recursive: true })

    await expect(resolveProjectRoot(standaloneDashboardDir)).resolves.toBe(root)
  })

  test("throws when av.yaml cannot be found", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "av-bootstrap-miss-"))
    tempDirs.push(root)

    await expect(resolveProjectRoot(root)).rejects.toThrow("av.yaml not found")
  })

  test("ignores valley.yaml as a project root marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "av-bootstrap-old-config-"))
    tempDirs.push(root)
    await writeFile(path.join(root, "valley.yaml"), "linear:\n  team_id: OLD\n")
    const nested = path.join(root, "apps", "dashboard")
    await mkdir(nested, { recursive: true })

    await expect(resolveProjectRoot(nested)).rejects.toThrow("av.yaml not found")
  })
})
