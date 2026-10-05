import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
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
const execute = promisify(execFile)
let root: string | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("configured MCP tools in isolated parallel Actors", () => {
  it("prepares ignored trusted MCP configuration in both Actor clones without changing the source config", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "av-continuous-mcp-")))
    await execute("git", ["init", "-qb", "main"], { cwd: root })
    await writeFile(join(root, ".gitignore"), ".agent-valley/\n.agents/\n.mcp.json\nORDER-*/\n")
    await writeFile(join(root, "README.md"), "Parallel MCP fixture\n")
    await execute("git", ["add", "."], { cwd: root })
    await execute(
      "git",
      ["-c", "user.name=AV Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
      { cwd: root },
    )
    const config = JSON.stringify({
      mcpServers: { aside: { command: "fake-aside", args: [] } },
      unrelated: "must not copy",
    })
    await writeFile(join(root, ".mcp.json"), config)
    const script = join(root, ".agent-valley", "fake-actor.cjs")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(root, ".agent-valley"))
    await writeFile(
      script,
      `
const fs=require('node:fs');let prompt='';
process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
 const config=JSON.parse(fs.readFileSync('.mcp.json','utf8'));
 if(!config.mcpServers?.aside || config.unrelated!==undefined)throw new Error('Trusted MCP namespace was not prepared');
 const criteria=['left.txt contains left result','right.txt contains right result'];
 const passed={passed:true,summary:'Inspected actual files.',findings:[]};let result;
 if(prompt.startsWith('You are the Chief Director coordinating'))result={
  goalBrief:{interpretation:'Write two files',assumptions:[],successCriteria:criteria},
  actors:[['chief-director','Chief Director'],['technical-director','Technical Director'],['design-director','Design Director'],['marketing-director','Marketing Director'],['left','Left writer'],['right','Right writer']].map(([id,name])=>({id,name,role:'Complete assigned work',actorType:'claude',skills:[]})),
  tasks:['left','right'].map((side,i)=>({id:side,title:'Write '+side,actorId:side,instructions:'Write '+side+'.txt',acceptance:[criteria[i]],dependencies:[]})),
  verificationContract:{version:1,criteria:criteria.map((criterion,i)=>({criterion,checks:[{kind:'file',path:(i?'right':'left')+'.txt',contains:[(i?'right':'left')+' result']}]}))}};
 else if(prompt.startsWith('You are Left writer.')||prompt.startsWith('You are Right writer.')){
  const side=prompt.startsWith('You are Left writer.')?'left':'right';fs.writeFileSync(side+'.txt',side+' result');result='Wrote '+side+'.txt with configured MCP metadata available';
 }
 else if(prompt.startsWith('Perform the Chief Director'))result={...passed,criteria:criteria.map(criterion=>({criterion,passed:true,evidence:'Read the checked file'}))};
 else if(prompt.startsWith("Write the Chief Director's outcome report"))result={summary:'Two files verified',eli5:'Both files are ready.',goalAssessment:'Both criteria passed.',assumptions:[],decisions:[],deliverables:['left.txt','right.txt'],checks:['Files verified'],remaining:[]};
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
    const mission = await runOrder("Write two verified files", { workspace: root, timeout: "10" }, root)
    expect(mission.status).toBe("completed")
    expect(mission.tasks).toHaveLength(2)
    expect(await readFile(join(mission.workspace.path, "left.txt"), "utf8")).toBe("left result")
    expect(await readFile(join(mission.workspace.path, "right.txt"), "utf8")).toBe("right result")
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(config)
    expect((await execute("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("")
  }, 20_000)
})
