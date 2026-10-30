import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createContinuousMissionWorkspace,
  prepareContinuousBaseline,
} from "@agent-valley/core/chief/continuous-workspace"
import { fingerprintWorkspace } from "@agent-valley/core/chief/fingerprint"
import { afterEach, describe, expect, it } from "vitest"
import { deliverMissionCode, prepareCodeDelivery } from "../chief-code-delivery"
import { deliveryFixture, git } from "./chief-code-delivery.fixture"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("continuous delivery commit objects", () => {
  it("delivers a second frozen-snapshot child whose pinned source base commit is initially absent", async () => {
    const { temporary, source, remote, workspace, mission, store } = await deliveryFixture()
    directories.push(temporary)
    const firstWorkspaceHead = await git(workspace, "rev-parse", "HEAD")
    const firstWorkspaceIndex = await git(workspace, "write-tree")
    const firstWorkspaceStatus = await git(workspace, "status", "--porcelain=v1")

    await deliverMissionCode(mission, store)

    expect(mission.codeDelivery?.phase).toBe("pushed")
    const firstCommit = await git(source, "rev-parse", "HEAD")
    expect(firstCommit).toBe(mission.codeDelivery?.commitSha)
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(firstCommit)
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(firstWorkspaceHead)
    expect(await git(workspace, "write-tree")).toBe(firstWorkspaceIndex)
    expect(await git(workspace, "status", "--porcelain=v1")).toBe(firstWorkspaceStatus)

    const operationId = randomUUID()
    const accepted = await prepareContinuousBaseline(
      source,
      operationId,
      workspace,
      mission.id,
      mission.verification?.fingerprint,
    )
    const secondId = randomUUID()
    const secondWorkspace = await createContinuousMissionWorkspace(
      source,
      operationId,
      accepted.path,
      secondId,
      mission.goal,
    )
    expect(await readFile(join(secondWorkspace.path, "allowed.ts"), "utf8")).toBe("export const value = 2\n")
    await expect(git(secondWorkspace.path, "cat-file", "-e", `${firstCommit}^{commit}`)).rejects.toThrow()
    const secondDelivery = await prepareCodeDelivery(source, {
      deliver: "main",
      deliveryPaths: ["allowed.ts"],
      deliveryMessage: "fix: deliver the next verified improvement",
    })
    expect(secondDelivery?.policy.baseSha).toBe(firstCommit)
    await writeFile(join(secondWorkspace.path, "allowed.ts"), "export const value = 3\n")
    const secondFingerprint = await fingerprintWorkspace(secondWorkspace.path)
    const secondMission = {
      ...structuredClone(mission),
      id: secondId,
      workspace: secondWorkspace,
      codeDelivery: secondDelivery,
      fingerprint: secondFingerprint,
      verification: { ok: true, output: "The second trusted oracle passed", fingerprint: secondFingerprint },
    }
    await store.save(secondMission)
    const secondWorkspaceHead = await git(secondWorkspace.path, "rev-parse", "HEAD")
    const secondWorkspaceIndex = await git(secondWorkspace.path, "write-tree")
    const secondWorkspaceStatus = await git(secondWorkspace.path, "status", "--porcelain=v1")

    await deliverMissionCode(secondMission, store)

    expect(secondMission.codeDelivery?.phase).toBe("pushed")
    const secondCommit = await git(source, "rev-parse", "HEAD")
    expect(secondCommit).toBe(secondMission.codeDelivery?.commitSha)
    expect(secondCommit).not.toBe(firstCommit)
    expect(await git(source, "rev-parse", "HEAD^")).toBe(firstCommit)
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(secondCommit)
    expect(await readFile(join(source, "allowed.ts"), "utf8")).toBe("export const value = 3\n")
    expect(await git(source, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
    expect(await git(secondWorkspace.path, "cat-file", "-t", firstCommit)).toBe("commit")
    expect(await git(secondWorkspace.path, "rev-parse", "HEAD")).toBe(secondWorkspaceHead)
    expect(await git(secondWorkspace.path, "write-tree")).toBe(secondWorkspaceIndex)
    expect(await git(secondWorkspace.path, "status", "--porcelain=v1")).toBe(secondWorkspaceStatus)
    expect(await fingerprintWorkspace(secondWorkspace.path)).toBe(secondFingerprint)
  })
})
