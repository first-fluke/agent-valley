import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fingerprintWorkspace } from "./fingerprint"
import { MissionStore } from "./store"
import type { Mission } from "./types"

const exec = promisify(execFile)
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-storage-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function mission(): Mission {
  return {
    id: "order-1",
    goal: "Write a report",
    chiefId: "chief",
    verifyCommand: "test -s report.md",
    timeoutSec: 10,
    maxRepairs: 1,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
    workspace: {
      issueId: "order-1",
      path: root,
      key: "order-1",
      branch: "chief/order-1",
      status: "idle",
      createdAt: "2026-10-03",
    },
    personas: [
      { id: "chief", name: "Chief Director", role: "Coordinate", agentType: "claude", skills: [] },
      { id: "writer", name: "Writer", role: "Research", agentType: "claude", skills: [] },
    ],
  }
}

describe("MissionStore", () => {
  it("atomically saves a private versioned record and reloads its complete state", async () => {
    const store = new MissionStore(join(root, "missions"))
    const value = mission()
    await store.save(value)
    expect(await store.load(value.id)).toEqual(value)
    const path = join(root, "missions", "order-1.json")
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    value.status = "failed"
    value.error = "A check failed. Correct the report."
    await store.save(value)
    expect((await store.load(value.id)).error).toBe(value.error)
    expect(await readdir(join(root, "missions"))).toEqual(["order-1.json"])
  })

  it("does not replace an intact record with invalid state", async () => {
    const store = new MissionStore(root)
    const value = mission()
    await store.save(value)
    await expect(store.save({ ...value, verifyCommand: "" })).rejects.toThrow()
    expect(await store.load(value.id)).toEqual(value)
  })

  it("rejects path traversal, unsupported versions, and mismatched identities", async () => {
    const store = new MissionStore(root)
    await expect(store.load("../secret")).rejects.toThrow("Invalid mission ID")
    await writeFile(join(root, "order-1.json"), JSON.stringify({ version: 2, mission: mission() }))
    await expect(store.load("order-1")).rejects.toThrow("Unsupported mission record version")
    await writeFile(join(root, "order-1.json"), JSON.stringify({ version: 1, mission: { ...mission(), id: "other" } }))
    await expect(store.load("order-1")).rejects.toThrow("identity does not match")
  })

  it("lists only mission records and handles a missing directory", async () => {
    const store = new MissionStore(join(root, "missions"))
    expect(await store.list()).toEqual([])
    const value = mission()
    await store.save(value)
    await writeFile(join(root, "missions", "unfinished.tmp"), "partial JSON")
    expect(await store.list()).toEqual([value])
  })

  it("blocks concurrent resumes of a live process until its lock is released", async () => {
    const store = new MissionStore(root)
    const unlock = await store.lock("order-1")
    await expect(store.lock("order-1")).rejects.toThrow(`already running (PID ${process.pid})`)
    await unlock()
    const secondUnlock = await store.lock("order-1")
    await secondUnlock()
    expect(await readdir(root)).toEqual([])
  })

  it("reclaims a lock only after its process is gone", async () => {
    const store = new MissionStore(root)
    await writeFile(join(root, "order-1.json.lock"), JSON.stringify({ pid: 987654, token: "old" }))
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" })
    })
    const unlock = await store.lock("order-1")
    expect(kill).toHaveBeenCalledWith(987654, 0)
    expect(JSON.parse(await readFile(join(root, "order-1.json.lock"), "utf8")).pid).toBe(process.pid)
    await unlock()
  })

  it("retains invalid locks and does not unlock a replacement owner", async () => {
    const store = new MissionStore(root)
    const path = join(root, "order-1.json.lock")
    await writeFile(path, JSON.stringify({ pid: 0, token: "invalid" }))
    await expect(store.lock("order-1")).rejects.toThrow("Invalid mission lock")
    await unlink(path)
    const unlock = await store.lock("order-1")
    await writeFile(path, JSON.stringify({ pid: process.pid, token: "replacement" }))
    await unlock()
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("replacement")
  })
})

describe("workspace fingerprint", () => {
  beforeEach(async () => {
    await exec("git", ["init", "-q", root])
    await writeFile(join(root, "product.txt"), "original")
    await writeFile(join(root, ".gitignore"), "node_modules/\ncoverage/\n")
    await exec("git", ["add", "product.txt", ".gitignore"], { cwd: root })
  })

  it("detects tracked edits, deletion, new reports, and executable mode changes", async () => {
    const original = await fingerprintWorkspace(root)
    await writeFile(join(root, "product.txt"), "edited")
    expect(await fingerprintWorkspace(root)).not.toBe(original)
    await writeFile(join(root, "product.txt"), "original")
    expect(await fingerprintWorkspace(root)).toBe(original)
    await chmod(join(root, "product.txt"), 0o755)
    expect(await fingerprintWorkspace(root)).not.toBe(original)
    await chmod(join(root, "product.txt"), 0o644)
    await unlink(join(root, "product.txt"))
    expect(await fingerprintWorkspace(root)).not.toBe(original)
    await writeFile(join(root, "product.txt"), "original")
    await writeFile(join(root, "report.md"), "Research evidence")
    expect(await fingerprintWorkspace(root)).not.toBe(original)
  })

  it("excludes runtime state and ignored generated artifacts while preserving product evidence", async () => {
    const original = await fingerprintWorkspace(root)
    for (const directory of [
      ".agent-valley/missions",
      ".agents/state",
      ".agents/results",
      "node_modules",
      "coverage",
    ]) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, directory, "generated.json"), "runtime state")
    }
    expect(await fingerprintWorkspace(root)).toBe(original)
    await writeFile(join(root, "report.md"), "Actual deliverable")
    expect(await fingerprintWorkspace(root)).not.toBe(original)
  })

  it("hashes a symlink target without reading outside the worktree", async () => {
    const target = join(root, "link")
    await symlink("/missing/private-target", target)
    const original = await fingerprintWorkspace(root)
    await unlink(target)
    await symlink("/different/private-target", target)
    expect(await fingerprintWorkspace(root)).not.toBe(original)
  })

  it("rejects tracked paths whose parent directory escapes through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "chief-outside-"))
    try {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src", "product.txt"), "original")
      await exec("git", ["add", "src/product.txt"], { cwd: root })
      await rm(join(root, "src"), { recursive: true })
      await writeFile(join(outside, "product.txt"), "outside content")
      await symlink(outside, join(root, "src"))
      await expect(fingerprintWorkspace(root)).rejects.toThrow(/symlink|outside|escape/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("fails closed for submodules whose nested product changes are not tracked", async () => {
    await mkdir(join(root, "nested"))
    await exec(
      "git",
      ["update-index", "--add", "--cacheinfo", "160000,1234567890123456789012345678901234567890,nested"],
      { cwd: root },
    )
    await expect(fingerprintWorkspace(root)).rejects.toThrow("submodule")
  })

  it("fails with remediation when Git metadata is unavailable", async () => {
    await rm(join(root, ".git"), { recursive: true, force: true })
    await expect(fingerprintWorkspace(root)).rejects.toThrow("Restore its Git metadata")
  })
})
