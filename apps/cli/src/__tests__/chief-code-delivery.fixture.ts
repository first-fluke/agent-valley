import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { fingerprintWorkspace } from "@agent-valley/core/workspace/fingerprint"
import { prepareCodeDelivery } from "../chief-code-delivery"

const exec = promisify(execFile)
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim()
}

export async function deliveryFixture(advance = false) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "av-code-delivery-")))
  const source = join(temporary, "source")
  const remote = join(temporary, "remote.git")
  const workspace = join(temporary, "workspace")
  await mkdir(source)
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.name", "AV delivery fixture")
  await git(source, "config", "user.email", "fixture@example.test")
  await writeFile(join(source, ".gitignore"), ".agent-valley/\n")
  await writeFile(join(source, "allowed.ts"), "export const value = 1\n")
  await writeFile(join(source, "other.ts"), "export const other = 1\n")
  await git(source, "add", ".")
  await git(source, "commit", "-m", "test: initial fixture")
  await git(temporary, "init", "--bare", "-b", "main", remote)
  await git(source, "remote", "add", "origin", remote)
  await git(source, "push", "-u", "origin", "main")
  if (advance) {
    await writeFile(join(source, "other.ts"), "export const other = 2\n")
    await git(source, "add", "other.ts")
    await git(source, "commit", "-m", "fix: approved local infrastructure")
  }
  const delivery = await prepareCodeDelivery(source, {
    deliver: "main",
    deliveryPaths: ["allowed.ts", "new.ts"],
    deliveryMessage: "fix: deliver verified feature",
  })
  await git(temporary, "clone", "--quiet", source, workspace)
  await writeFile(join(workspace, "allowed.ts"), "export const value = 2\n")
  const mission = missionFixture()
  mission.id = randomUUID()
  mission.repositoryRoot = source
  mission.workspace = { ...mission.workspace, issueId: mission.id, key: mission.id, path: workspace, branch: "main" }
  mission.codeDelivery = delivery
  if (mission.supervision) mission.supervision.operatorGoal = mission.goal
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxDurationSec: 300 })
  mission.execution = { startedAt: new Date().toISOString(), runsStarted: 8, retries: 1 }
  const store = new MissionStore(join(source, ".agent-valley", "missions"))
  const verify = async () => {
    mission.fingerprint = await fingerprintWorkspace(workspace)
    mission.verification = { ok: true, output: "Fixed trusted oracle passed", fingerprint: mission.fingerprint }
    await store.save(mission)
  }
  await verify()
  return { temporary, source, remote, workspace, mission, store, verify }
}
