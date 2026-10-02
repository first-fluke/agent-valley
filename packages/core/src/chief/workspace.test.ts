import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Mission } from "./types"
import { assertMissionWorkspace } from "./workspace"

const exec = promisify(execFile)
let root: string
let mission: Mission

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-identity-"))
  await exec("git", ["init", "-q", "-b", "chief-test"], { cwd: root })
  await writeFile(join(root, "README.md"), "Fixture")
  await exec("git", ["add", "README.md"], { cwd: root })
  await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Chief Test",
      "-c",
      "user.email=chief@example.test",
      "commit",
      "-qm",
      "fixture",
      "--no-gpg-sign",
    ],
    { cwd: root },
  )
  mission = {
    id: "identity-test",
    goal: "Check workspace",
    chiefId: "chief",
    personas: [],
    workspace: {
      issueId: "identity-test",
      path: root,
      key: "identity-test",
      branch: "chief-test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status: "pending",
    tasks: [],
    history: [],
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("chief mission workspace identity", () => {
  it("accepts the recorded branch at the exact repository root", async () => {
    await expect(assertMissionWorkspace(mission)).resolves.toBeUndefined()
  })

  it("rejects a different branch before resuming a saved mission", async () => {
    await exec("git", ["checkout", "-qb", "different-task"], { cwd: root })
    await expect(assertMissionWorkspace(mission)).rejects.toThrow("Restore its Git metadata and branch")
  })

  it("rejects detached HEAD even at the same commit", async () => {
    await exec("git", ["checkout", "-q", "--detach"], { cwd: root })
    await expect(assertMissionWorkspace(mission)).rejects.toThrow("not on branch chief-test")
  })

  it("rejects missing Git metadata and does not fall back to a parent repository", async () => {
    const nested = join(root, "mission")
    await mkdir(nested)
    mission.workspace.path = nested
    await expect(assertMissionWorkspace(mission)).rejects.toThrow("Restore its Git metadata")
    mission.workspace.path = root
    await rm(join(root, ".git"), { recursive: true, force: true })
    await expect(assertMissionWorkspace(mission)).rejects.toThrow("Restore its Git metadata")
  })

  it("rejects a workspace assigned to another mission", async () => {
    mission.workspace.issueId = "other-mission"
    await expect(assertMissionWorkspace(mission)).rejects.toThrow("Restore its Git metadata")
  })
})
