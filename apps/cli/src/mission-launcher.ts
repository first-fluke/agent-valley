import { spawn } from "node:child_process"
import { open } from "node:fs/promises"
import { processIdentity } from "@agent-valley/core/chief/process-identity"

export interface MissionLaunch {
  args: string[]
  workspace: string
  logPath: string
}

/** The MCP connection owns neither the supervisor's lifetime nor its stdout. */
export async function launchMission(input: MissionLaunch): Promise<{ pid: number; identity?: string }> {
  const entry = process.argv[1]
  if (!entry) throw new Error("AV entry point is unavailable. Start the server with the installed `av mcp` command.")
  const log = await open(input.logPath, "wx", 0o600)
  try {
    const child = spawn(process.execPath, [entry, ...input.args], {
      cwd: input.workspace,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env },
    })
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn)
      child.once("error", reject)
    })
    if (!child.pid) throw new Error("AV supervisor did not provide a process ID. Inspect its launch log.")
    child.unref()
    return { pid: child.pid, identity: processIdentity(child.pid) }
  } finally {
    await log.close()
  }
}
