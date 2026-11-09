import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { intermediateVerifyCommand } from "./runtime"

const directories: string[] = []

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "av-chief-oma-"))
  directories.push(root)
  git(root, ["init", "-q"])
  git(root, ["config", "user.name", "Chief Director Fixture"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["config", "core.whitespace", "blank-at-eol,blank-at-eof,space-before-tab"])
  writeFileSync(join(root, "input.txt"), "Initial input\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Initial fixture"])
  return root
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("binds the intermediate task check to its starting commit and flags committed whitespace", async () => {
  const root = repository()
  const base = git(root, ["rev-parse", "HEAD"])
  const command = await intermediateVerifyCommand(root)
  expect(command).toBe(`git diff --check ${base} --`)
  expect(spawnSync("git", ["diff", "--check", base, "--"], { cwd: root }).status).toBe(0)
  writeFileSync(join(root, "input.txt"), "Trailing spaces   \n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Commit broken first stage"])
  expect(spawnSync("git", ["diff", "--check", base, "--"], { cwd: root }).status).not.toBe(0)
})

test("fails closed instead of guessing a baseline without a starting commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-chief-oma-empty-"))
  directories.push(root)
  git(root, ["init", "-q"])
  await expect(intermediateVerifyCommand(root)).rejects.toThrow("starting commit")
})
