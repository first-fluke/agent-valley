import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"

let root: string
let source: string
let target: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "av-install-"))
  source = join(root, "source")
  target = join(root, "target")
  for (const path of ["scripts/harness", ".agents"]) mkdirSync(join(source, path), { recursive: true })
  mkdirSync(target)
  cpSync(resolve("scripts/install.sh"), join(source, "scripts/install.sh"))
  for (const name of ["gc.sh", "validate.sh"])
    writeFileSync(join(source, "scripts/harness", name), "#!/bin/sh\nexit 0\n")
  writeFileSync(join(source, "AGENTS.md"), "Source instructions\n")
  writeFileSync(join(source, ".gitignore"), "dist/\nvalley.yaml\n")
  writeFileSync(join(source, "package.json"), "{}")
  writeFileSync(join(target, "package.json"), "{}")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function install(cwd: string) {
  return spawnSync("bash", [join(source, "scripts/install.sh"), "--yes", "--no-workflows"], { cwd, encoding: "utf8" })
}

test("running inside a clone leaves its existing instructions intact", () => {
  const result = install(source)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("bun av setup")
  expect(readFileSync(join(source, "AGENTS.md"), "utf8")).toBe("Source instructions\n")
})

test("repeated install preserves existing instructions and deduplicates exact ignore entries", () => {
  writeFileSync(join(target, "AGENTS.md"), "Project-specific instructions\n")
  writeFileSync(join(target, ".gitignore"), "other-dist/\n")
  expect(install(target).status).toBe(0)
  const result = install(target)
  expect(result.status).toBe(0)
  const instructions = readFileSync(join(target, "AGENTS.md"), "utf8")
  expect(instructions).toContain("Project-specific instructions")
  expect(instructions.match(/## Symphony Harness/g)).toHaveLength(1)
  const ignores = readFileSync(join(target, ".gitignore"), "utf8").split("\n")
  expect(ignores.filter((line) => line === "dist/")).toHaveLength(1)
  expect(result.stdout).toContain("does not install the agent farm CLI/dashboard")
})
