import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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

  test("walks up from standalone dashboard path to find WORKFLOW.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "av-bootstrap-"))
    tempDirs.push(root)

    await writeFile(path.join(root, "WORKFLOW.md"), "---\n---\n")

    const standaloneDashboardDir = path.join(root, "apps", "dashboard", ".next", "standalone", "apps", "dashboard")
    await mkdir(standaloneDashboardDir, { recursive: true })

    await expect(resolveProjectRoot(standaloneDashboardDir)).resolves.toBe(root)
  })

  test("throws when WORKFLOW.md cannot be found", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "av-bootstrap-miss-"))
    tempDirs.push(root)

    await expect(resolveProjectRoot(root)).rejects.toThrow("WORKFLOW.md not found")
  })
})
