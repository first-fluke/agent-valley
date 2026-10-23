import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"

let directory: string
let home: string
let external: ChildProcess | undefined
const groups = new Set<number>()

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function awaitGone(pid: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (exists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(exists(pid), `Probe process or group ${pid} did not exit`).toBe(false)
}

function plan(args: string[] = []) {
  return buildDarwinSandboxCommand(
    { agentType: "claude", command: process.execPath, args, workspacePath: directory, networkAllowlist: [] },
    "/usr/bin/sandbox-exec",
    home,
  )
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "av-seatbelt-signals-")))
  home = join(directory, "home")
  mkdirSync(home)
})

afterEach(async () => {
  // Every probe has a self-exit deadline. Cleanup never signals an unrelated process.
  if (external) {
    const closed = new Promise<void>((resolve) => {
      if (external?.exitCode !== null || external.signalCode !== null) return resolve()
      external.once("close", () => resolve())
    })
    external.stdin?.end()
    await closed
    external = undefined
  }
  for (const group of groups) await awaitGone(-group, 6_000)
  groups.clear()
  rmSync(directory, { recursive: true, force: true })
})

describe("Darwin sandbox descendant cancellation", () => {
  it("allows signals only to self and processes sharing the sandbox", () => {
    const profile = plan().args[1] as string
    expect(profile.split("\n").filter((line) => line.startsWith("(allow signal"))).toEqual([
      "(allow signal (target self))",
      "(allow signal (target same-sandbox))",
    ])
    expect(profile).toContain("(deny default)")
  })

  it.skipIf(process.platform !== "darwin")(
    "terminates child and grandchild groups while denying signals to a live host process",
    async () => {
      external = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));setTimeout(()=>process.exit(0),10000)",
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      )
      expect(external.pid).toBeTypeOf("number")
      const childReceipt = join(directory, "child-terminated")
      const grandchildReceipt = join(directory, "grandchild-terminated")
      const grandchild = `
        const fs=require('node:fs');
        process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(grandchildReceipt)},'SIGTERM');process.exit(0)});
        console.log(process.pid);
        setTimeout(()=>process.exit(0),4000);
      `
      const child = `
        const fs=require('node:fs');const {spawn}=require('node:child_process');
        process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(childReceipt)},'SIGTERM');process.exit(0)});
        const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});
        grandchild.stdout.once('data',data=>console.log(JSON.stringify({child:process.pid,grandchild:Number(String(data).trim())})));
        setTimeout(()=>process.exit(0),4000);
      `
      const controller = `
        const fs=require('node:fs');const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:['ignore','pipe','ignore']});
        const attempt=(pid,signal)=>{try{process.kill(pid,signal);return 'allowed'}catch(error){return error.code}};
        child.stdout.once('data',data=>{
          const pids=JSON.parse(String(data));
          const directChild=attempt(pids.child,'SIGCONT');
          const directGrandchild=attempt(pids.grandchild,'SIGCONT');
          const outside=attempt(${external.pid},'SIGCONT');
          const cancellation=attempt(-pids.child,'SIGTERM');
          const finish=()=>{
            if(!fs.existsSync(${JSON.stringify(childReceipt)})||!fs.existsSync(${JSON.stringify(grandchildReceipt)}))return setTimeout(finish,20);
            console.log(JSON.stringify({pids,directChild,directGrandchild,outside,cancellation,
              childTerminated:fs.existsSync(${JSON.stringify(childReceipt)}),
              grandchildTerminated:fs.existsSync(${JSON.stringify(grandchildReceipt)})}));
            process.exit(0);
          };
          finish();
        });
        setTimeout(()=>process.exit(3),5000);
      `
      const command = plan(["-e", controller])
      const result = spawnSync(command.command, command.args, { cwd: directory, encoding: "utf8", timeout: 6_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const observed = JSON.parse(result.stdout)
      groups.add(observed.pids.child)
      expect(observed).toMatchObject({
        directChild: "allowed",
        directGrandchild: "allowed",
        outside: "EPERM",
        cancellation: "allowed",
        childTerminated: true,
        grandchildTerminated: true,
      })
      await awaitGone(observed.pids.child, 3_000)
      await awaitGone(observed.pids.grandchild, 3_000)
      await awaitGone(-observed.pids.child, 3_000)
      expect(exists(external.pid as number)).toBe(true)
    },
    15_000,
  )
})
