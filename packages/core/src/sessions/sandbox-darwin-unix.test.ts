import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"

let root: string
let workspace: string
let workspaceAlias: string
let temporary: string
let temporaryAlias: string
let home: string
let outside: string

beforeEach(() => {
  root = realpathSync(mkdtempSync("/tmp/avs-"))
  workspace = join(root, "w")
  workspaceAlias = join(root, "wa")
  temporary = join(root, "t")
  temporaryAlias = join(root, "ta")
  home = join(root, "h")
  outside = join(root, "o")
  for (const path of [workspace, temporary, home, outside, join(home, ".cache"), join(home, ".claude")]) mkdirSync(path)
  symlinkSync(workspace, workspaceAlias, "dir")
  symlinkSync(temporary, temporaryAlias, "dir")
  // Keep external fixture/cache paths outside the sandbox's temporary allowance.
  vi.stubEnv("TMPDIR", temporaryAlias)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function run(
  script: string,
  args: string[],
  options: { workspacePath?: string; cwd?: string; extraRules?: string } = {},
) {
  const command = buildDarwinSandboxCommand(
    {
      agentType: "claude",
      command: process.execPath,
      args: ["-e", script, ...args],
      workspacePath: options.workspacePath ?? workspaceAlias,
      networkAllowlist: [],
    },
    "/usr/bin/sandbox-exec",
    home,
  )
  if (options.extraRules) command.args[1] += `\n${options.extraRules}`
  const result = spawnSync(command.command, command.args, {
    cwd: options.cwd ?? workspaceAlias,
    encoding: "utf8",
    timeout: 5_000,
  })
  expect(result.error).toBeUndefined()
  return result
}

const roundtrip = `
  const fs=require('node:fs'),net=require('node:net');
  const path=process.argv[1];let accepted=false;
  if(process.argv[2])fs.writeFileSync(process.argv[2],'file-write-allowed');
  const server=net.createServer(socket=>{accepted=true;socket.end('local-response')});
  server.on('error',error=>{console.log(JSON.stringify({phase:'bind',code:error.code}));process.exit(3)});
  server.listen(path,()=>{
    const client=net.connect(path);let response='';
    client.on('data',data=>response+=data);
    client.on('error',error=>{console.log(JSON.stringify({phase:'connect',code:error.code}));process.exit(4)});
    client.on('end',()=>server.close(()=>{
      console.log(JSON.stringify({accepted,response}));
      process.exit(accepted&&response==='local-response'?0:5);
    }));
  });
  setTimeout(()=>process.exit(6),3000).unref();
`

describe.skipIf(process.platform !== "darwin")("Darwin named Unix socket confinement", () => {
  it.each(["workspace", "workspace alias", "temporary", "temporary alias"])(
    "compiles the profile and binds, accepts and exchanges data inside %s",
    (location) => {
      const path =
        location === "workspace"
          ? workspace
          : location === "workspace alias"
            ? workspaceAlias
            : location === "temporary"
              ? temporary
              : temporaryAlias
      const result = run(roundtrip, [join(path, "u.sock")])
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ accepted: true, response: "local-response" })
    },
  )

  it("binds and exchanges data at a relative socket path inside a long workspace cwd", () => {
    const longWorkspace = join(workspace, "nested".repeat(24))
    const socket = ".arc-verify/s/arc.sock"
    mkdirSync(join(longWorkspace, ".arc-verify", "s"), { recursive: true })
    expect(Buffer.byteLength(join(longWorkspace, socket))).toBeGreaterThan(104)
    const result = run(roundtrip, [socket], { workspacePath: longWorkspace, cwd: longWorkspace })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ accepted: true, response: "local-response" })
  })

  it.each(["external", "shared cache", "active vendor home"])(
    "denies Unix bind in %s even when filesystem writes there are allowed",
    (location) => {
      const path = location === "external" ? outside : join(home, location === "shared cache" ? ".cache" : ".claude")
      const marker = join(path, "marker")
      const result = run(roundtrip, [join(path, "u.sock"), marker], {
        // Isolate the network decision from the filesystem deny for the external path.
        extraRules: `(allow file-write* (subpath ${JSON.stringify(path)}))`,
      })
      expect(readFileSync(marker, "utf8")).toBe("file-write-allowed")
      expect(result.status, result.stderr).toBe(3)
      expect(JSON.parse(result.stdout)).toEqual({ phase: "bind", code: "EPERM" })
    },
  )

  it("keeps TCP listeners denied", () => {
    const result = run(
      `
      const server=require('node:net').createServer();
      server.on('error',error=>{console.log(error.code);process.exit(3)});
      server.listen({host:'127.0.0.1',port:0},()=>{server.close();process.exit(2)});
      setTimeout(()=>process.exit(4),3000).unref();
    `,
      [],
    )
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout.trim()).toBe("EPERM")
  })

  it("preserves credential read and write denies inside an otherwise allowed workspace", () => {
    const credentials = join(home, ".agent-valley")
    mkdirSync(credentials)
    const path = join(credentials, "credentials.json")
    writeFileSync(path, "synthetic-credential")
    const result = run(
      `
      const fs=require('node:fs');
      const denied=action=>{try{action();return false}catch(error){return ['EPERM','EACCES'].includes(error.code)}};
      const read=denied(()=>fs.readFileSync(process.argv[1]));
      const write=denied(()=>fs.writeFileSync(process.argv[1],'changed'));
      console.log(JSON.stringify({read,write}));process.exit(read&&write?0:2);
    `,
      [path],
      { workspacePath: home },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ read: true, write: true })
    expect(readFileSync(path, "utf8")).toBe("synthetic-credential")
  })
})
