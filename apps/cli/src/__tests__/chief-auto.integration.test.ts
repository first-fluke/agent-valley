import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { MissionStore } from "@agent-valley/core/chief/store"
import { planSandboxedSpawn } from "@agent-valley/core/sessions/sandbox"
import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverAgents } from "../agent-discovery"
import { runOrder } from "../chief"

vi.mock("@agent-valley/core/sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))
vi.mock("../agent-discovery", () => ({ discoverAgents: vi.fn() }))
vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))
let root: string | undefined
const exec = promisify(execFile)
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

describe("goal-only Chief CLI order", () => {
  it("plans immutable checks, runs isolated Actors, verifies actual evidence and resumes without a user command", async () => {
    root = await mkdtemp(join(tmpdir(), "av-chief-auto-"))
    const repo = join(root, "repo")
    const log = join(root, "calls.jsonl")
    await mkdir(repo)
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo })
    await exec("git", ["config", "user.name", "AV Test"], { cwd: repo })
    await exec("git", ["config", "user.email", "av@example.invalid"], { cwd: repo })
    await writeFile(join(repo, ".gitignore"), ".agent-valley/\n.agents/\n")
    await writeFile(join(repo, "README.md"), "Auto Chief fixture")
    await exec("git", ["add", "README.md", ".gitignore"], { cwd: repo })
    await exec("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign"], { cwd: repo })
    const script = join(root, "fake-chief.cjs")
    await writeFile(
      script,
      `
const fs=require('node:fs');let prompt='';
process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
 const stage=prompt.startsWith('You are the Chief Director coordinating')?'plan':
 prompt.startsWith("Review the mission plan as the Chief Director's Technical Director")?'technical-review':
 prompt.startsWith("Review the mission goal as the Chief Director's Design Director")?'design-review':
 prompt.startsWith("Review the mission goal as the Chief Director's Marketing Director")?'marketing-review':
 prompt.startsWith("Write the Chief Director's outcome report")?'report':
 prompt.startsWith('Perform the Chief Director')?'final-review':
 prompt.startsWith('Independently review')?'review':'work';
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({stage,cwd:process.cwd()})+'\\n');
 const criteria=['left.txt contains left result','right.txt contains right result'];
 const passed={passed:true,summary:'Inspected actual file evidence.',findings:[]};let result;
 if(stage==='plan')result={goalBrief:{interpretation:'Write two independent files',assumptions:[],successCriteria:criteria},
  actors:[['chief-director','Chief Director'],['technical-director','Technical Director'],['design-director','Design Director'],['marketing-director','Marketing Director'],['left','Left writer'],['right','Right writer']].map(([id,name])=>({id,name,role:'Complete assigned work',actorType:'claude',skills:[]})),
  tasks:['left','right'].map((side,i)=>({id:side,title:'Write '+side,actorId:side,instructions:'Create '+side+'.txt containing '+side+' result',acceptance:[criteria[i]],dependencies:[]})),
  verificationContract:{version:1,criteria:criteria.map((criterion,i)=>({criterion,checks:[{kind:'file',path:(i?'right':'left')+'.txt',contains:[(i?'right':'left')+' result']}]}))}};
 else if(stage==='work'){const side=prompt.startsWith('You are Left writer.')?'left':'right';fs.writeFileSync(side+'.txt',side+' result');result='Wrote '+side+'.txt';}
 else if(stage==='final-review')result={...passed,criteria:criteria.map(criterion=>({criterion,passed:true,evidence:'Observed the matching file and executable checks.'}))};
 else if(stage==='report')result={summary:'Two files verified',eli5:'Both requested files are ready and checked.',goalAssessment:'Both original criteria passed.',assumptions:[],decisions:[],deliverables:['left.txt','right.txt'],checks:['Actual file checks passed'],remaining:[]};
 else result=passed;
 process.stdout.write(JSON.stringify({type:'result',is_error:false,result:typeof result==='string'?result:JSON.stringify(result)})+'\\n');
});`,
    )
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.mocked(discoverAgents).mockResolvedValue([{ agentType: "claude", readiness: "ready", reason: "Fixture" }])
    vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
      command: process.execPath,
      args: [script],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    }))
    const mission = await runOrder(
      "Write left.txt and right.txt with their observed results",
      { workspace: repo, timeout: "10" },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.verifyCommand).toBe("")
    expect(mission.verificationMode).toBe("chief")
    expect(mission.executionPolicy?.maxParallel).toBe(3)
    expect(mission.goalVerification?.ok).toBe(true)
    expect(mission.goalVerification?.evidence).toHaveLength(2)
    expect(
      mission.goalVerification?.evidence.every(
        (entry) => entry.passed && entry.checks.every((check) => /^[a-f0-9]{64}$/.test(check.sha256 ?? "")),
      ),
    ).toBe(true)
    expect(await readFile(join(mission.workspace.path, "left.txt"), "utf8")).toBe("left result")
    expect(await readFile(join(mission.workspace.path, "right.txt"), "utf8")).toBe("right result")
    await expect(readFile(join(repo, "left.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; cwd: string })
    const workers = calls.filter((call) => call.stage === "work")
    expect(workers).toHaveLength(2)
    expect(new Set(workers.map((call) => call.cwd)).size).toBe(2)
    expect(workers.every((call) => call.cwd !== mission.workspace.path)).toBe(true)
    expect(await readFile(join(root, ".agent-valley/reports", `${mission.id}.md`), "utf8")).toContain(
      "Both requested files",
    )
    const stored = await new MissionStore(join(root, ".agent-valley/missions")).load(mission.id)
    expect(stored.verificationContract).toEqual(mission.verificationContract)
    const resumed = await runOrder(undefined, { resume: mission.id }, root)
    expect(resumed.status).toBe("completed")
    expect(resumed.verificationContractSha256).toBe(mission.verificationContractSha256)
    expect(resumed.tasks.every((task) => task.attempts === 1)).toBe(true)
    const resumedCalls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string })
    expect(resumedCalls.filter((call) => call.stage === "work")).toHaveLength(2)
  }, 20_000)
})
