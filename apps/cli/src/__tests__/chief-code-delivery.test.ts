import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as gate from "@agent-valley/core/orchestrator/verification-gate"
import { afterEach, describe, expect, it, vi } from "vitest"
import { deliverMissionCode, prepareCodeDelivery } from "../chief-code-delivery"
import { deliveryFixture, git } from "./chief-code-delivery.fixture"

const directories: string[] = []
async function fixture(advance = false) {
  const value = await deliveryFixture(advance)
  directories.push(value.temporary)
  return value
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function hook(source: string, name: string, body: string) {
  const path = join(source, ".git", "hooks", name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

describe("verified opt-in code delivery", () => {
  it("requires explicit branch and exact file permissions", async () => {
    expect(await prepareCodeDelivery("/unused", {})).toBeUndefined()
    await expect(prepareCodeDelivery("/unused", { deliveryPaths: ["allowed.ts"] })).rejects.toThrow("--deliver")
  })

  it.each([false, true])(
    "uses normal commit/push hooks and preserves spent budget (remote behind base: %s)",
    async (advance) => {
      const { source, workspace, remote, mission, store, verify } = await fixture(advance)
      await writeFile(join(workspace, "new.ts"), "export const added = true\n")
      await verify()
      await hook(source, "pre-commit", "echo commit >> .git/delivery-hook-receipt")
      await hook(source, "pre-push", "echo push >> .git/delivery-hook-receipt")
      const execution = structuredClone(mission.execution)
      const workspaceIndex = await git(workspace, "write-tree")
      const workspaceStatus = await git(workspace, "status", "--porcelain=v1")
      await deliverMissionCode(mission, store)
      expect(mission.codeDelivery?.error).toBeUndefined()
      expect(mission.codeDelivery?.phase).toBe("pushed")
      const commit = await git(source, "rev-parse", "HEAD")
      expect(commit).toBe(mission.codeDelivery?.commitSha)
      expect(await git(source, "rev-parse", "HEAD^")).toBe(mission.codeDelivery?.policy.baseSha)
      expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(commit)
      expect(await readFile(join(source, ".git", "delivery-hook-receipt"), "utf8")).toBe("commit\npush\n")
      expect(await readFile(join(source, "new.ts"), "utf8")).toBe("export const added = true\n")
      expect(await git(workspace, "write-tree")).toBe(workspaceIndex)
      expect(await git(workspace, "status", "--porcelain=v1")).toBe(workspaceStatus)
      expect(mission.execution).toEqual(execution)
    },
  )

  it.each(["tracked", "untracked", "symlink"] as const)(
    "blocks a %s path outside the verified delivery policy",
    async (kind) => {
      const { source, workspace, mission, store, verify } = await fixture()
      if (kind === "tracked") await writeFile(join(workspace, "other.ts"), "unexpected edit\n")
      if (kind === "untracked") await writeFile(join(workspace, "unexpected.ts"), "unexpected file\n")
      if (kind === "symlink") await symlink("other.ts", join(workspace, "new.ts"))
      await verify()
      await deliverMissionCode(mission, store)
      expect(mission.codeDelivery?.phase).toBe("blocked")
      expect(await git(source, "rev-parse", "HEAD")).toBe(mission.codeDelivery?.policy.baseSha)
      expect(await git(source, "status", "--porcelain=v1")).toBe("")
    },
  )

  it.each(["fingerprint", "dirty-target"] as const)("preserves %s drift and refuses main mutation", async (kind) => {
    const { source, workspace, mission, store } = await fixture()
    if (kind === "fingerprint") await writeFile(join(workspace, "allowed.ts"), "unverified change\n")
    else await writeFile(join(source, "operator.txt"), "preserve operator edits\n")
    await deliverMissionCode(mission, store)
    expect(mission.codeDelivery?.phase).toBe("blocked")
    expect(await git(source, "rev-parse", "HEAD")).toBe(mission.codeDelivery?.policy.baseSha)
    if (kind === "dirty-target")
      expect(await readFile(join(source, "operator.txt"), "utf8")).toBe("preserve operator edits\n")
  })

  it("retains a prepared index when the normal commit hook rejects it", async () => {
    const { source, mission, store } = await fixture()
    await hook(source, "pre-commit", "echo rejected > .git/hook-ran\nexit 1")
    await deliverMissionCode(mission, store)
    expect(mission.codeDelivery).toMatchObject({ phase: "prepared", attempts: 1 })
    expect(mission.codeDelivery?.nextRunAt).toBeDefined()
    expect(await readFile(join(source, ".git", "hook-ran"), "utf8")).toBe("rejected\n")
    expect(await git(source, "rev-parse", "HEAD")).toBe(mission.codeDelivery?.policy.baseSha)
    expect(await git(source, "write-tree")).toBe(mission.codeDelivery?.treeSha)
  })

  it("blocks an unrelated remote history without changing that remote", async () => {
    const { temporary, remote, mission, store } = await fixture()
    const other = join(temporary, "unrelated")
    await mkdir(other)
    await git(other, "init", "-b", "main")
    await git(other, "config", "user.name", "Unrelated fixture")
    await git(other, "config", "user.email", "unrelated@example.test")
    await writeFile(join(other, "unrelated.txt"), "independent history\n")
    await git(other, "add", ".")
    await git(other, "commit", "-m", "test: unrelated history")
    await git(remote, "fetch", other, "main")
    await git(remote, "update-ref", "refs/heads/main", "FETCH_HEAD")
    const observed = await git(remote, "rev-parse", "refs/heads/main")
    await deliverMissionCode(mission, store)
    expect(mission.codeDelivery?.phase).toBe("blocked")
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(observed)
  })

  it.each(["aborted", "expired"] as const)("blocks %s delivery before mutating the source", async (kind) => {
    const { source, mission, store } = await fixture()
    const controller = new AbortController()
    if (kind === "aborted") controller.abort()
    else {
      if (!mission.execution) throw new Error("Expected original execution clock")
      mission.execution.startedAt = new Date(Date.now() - 600_000).toISOString()
    }
    await deliverMissionCode(mission, store, controller.signal)
    expect(mission.codeDelivery?.phase).toBe("blocked")
    expect(await git(source, "rev-parse", "HEAD")).toBe(mission.codeDelivery?.policy.baseSha)
  })

  it("observes a lost push response before attempting another push", async () => {
    const { source, mission, store } = await fixture()
    const original = gate.runVerificationGate
    let pushes = 0
    vi.spyOn(gate, "runVerificationGate").mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1]?.includes("'push'")) {
        pushes += 1
        return { ...result, ok: false, output: "Push response lost" }
      }
      return result
    })
    await deliverMissionCode(mission, store)
    expect(mission.codeDelivery?.phase).toBe("pushed")
    await deliverMissionCode(mission, store)
    expect(pushes).toBe(1)
    expect(await git(source, "rev-list", "--count", "HEAD")).toBe("2")
  })

  it("recovers commit-save loss by exact tree, parent and nonce without a second commit", async () => {
    const { source, remote, mission, store } = await fixture()
    await hook(source, "pre-commit", "echo commit >> .git/commit-count")
    const save = store.save.bind(store)
    const failure = vi.spyOn(store, "save").mockImplementation(async (current) => {
      if (current.codeDelivery?.phase === "committed") throw new Error("Simulated checkpoint outage")
      return save(current)
    })
    await expect(deliverMissionCode(mission, store)).rejects.toThrow("checkpoint outage")
    failure.mockRestore()
    const restored = await store.load(mission.id)
    expect(restored.codeDelivery?.phase).toBe("prepared")
    await deliverMissionCode(restored, store)
    expect(restored.codeDelivery?.phase).toBe("pushed")
    expect(await git(source, "rev-list", "--count", "HEAD")).toBe("2")
    expect(await readFile(join(source, ".git", "commit-count"), "utf8")).toBe("commit\n")
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(restored.codeDelivery?.commitSha)
  })

  it("blocks source HEAD movement even when the saved commit is already on the remote", async () => {
    const { source, remote, mission, store } = await fixture()
    const save = store.save.bind(store)
    const failure = vi.spyOn(store, "save").mockImplementation(async (current) => {
      if (current.codeDelivery?.phase === "pushed") throw new Error("Lost pushed checkpoint")
      return save(current)
    })
    await expect(deliverMissionCode(mission, store)).rejects.toThrow("Lost pushed checkpoint")
    failure.mockRestore()
    const restored = await store.load(mission.id)
    const base = restored.codeDelivery?.policy.baseSha
    if (!base) throw new Error("Expected original base")
    expect(restored.codeDelivery?.phase).toBe("committed")
    await git(source, "reset", "--hard", base)
    await deliverMissionCode(restored, store)
    expect(restored.codeDelivery?.phase).toBe("blocked")
    expect(await git(source, "rev-parse", "HEAD")).toBe(base)
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(restored.codeDelivery?.commitSha)
  })
})
