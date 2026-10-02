import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const entrypoint = resolve(import.meta.dirname, "../index.ts")
let bun: string | undefined
try {
  // Resolve inside the checkout before moving to a fixture without its runtime
  // version config. A PATH shim can select another version or recurse via bin/bun.
  bun = execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
    cwd: resolve(import.meta.dirname, "../../../.."),
    encoding: "utf-8",
    timeout: 5_000,
  }).trim()
} catch {
  /* Bun is required for source execution. */
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  return address.port
}

describe.skipIf(!bun)("source CLI daemon lifecycle", () => {
  it("starts from supervisor.ts, returns to the shell, reads the configured port, and stops", async () => {
    if (!bun) throw new Error("Bun is required for this test")
    const bunBinary = bun
    const root = mkdtempSync(join(tmpdir(), "av-daemon-"))
    const port = await unusedPort()
    let publicPort = await unusedPort()
    while (publicPort === port) publicPort = await unusedPort()
    let pid: number | undefined
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    try {
      mkdirSync(join(root, "apps/dashboard"), { recursive: true })
      mkdirSync(join(root, "bin"))
      writeFileSync(join(root, "apps/dashboard/package.json"), "{}")
      writeFileSync(
        join(root, "valley.yaml"),
        `
linear:
  api_key: test-key
  team_id: TEST
  team_uuid: team
  webhook_secret: test-secret
  workflow_states:
    todo: todo
    in_progress: wip
    done: done
    cancelled: cancelled
workspace:
  root: ${root}/workspaces
prompt: "Test issue"
verify:
  command: "true"
server:
  port: ${port}
tunnel:
  provider: none
`,
      )
      // The fixture only serves health/status; it never starts Next.js or an agent.
      writeFileSync(
        join(root, "dashboard.mjs"),
        `
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', isRunning: true, activeAgents: 0 }));
});
server.listen(Number(args[args.indexOf('-p') + 1]), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
      )
      writeFileSync(
        join(root, "bin/bun"),
        `#!/bin/sh
if [ "$1" = "next" ]; then
  shift
  exec ${quote(process.execPath)} ${quote(join(root, "dashboard.mjs"))} "$@"
fi
exec ${quote(bunBinary)} "$@"
`,
        { mode: 0o755 },
      )
      const env = {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        XDG_CONFIG_HOME: join(root, "config"),
        SERVER_PORT: undefined,
        SYMPHONY_WEBHOOK_PORT: String(publicPort),
        SYMPHONY_DASHBOARD_HOST: "127.0.0.1",
        SYMPHONY_DASHBOARD_TOKEN: undefined,
        SYMPHONY_INTERVENTION_TOKEN: undefined,
      }
      const command = async (args: string[]) => {
        try {
          return await run(bunBinary, [entrypoint, ...args], { cwd: root, env, timeout: 15_000 })
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string }
          const logPath = join(root, ".av.log")
          const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "No supervisor log was created."
          throw new Error(
            `${failure.message}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}\nsupervisor log:\n${log}`,
            { cause: error },
          )
        }
      }
      const started = await command(["up", "--dev"])
      expect(started.stdout).toContain(`http://localhost:${port}`)
      expect(started.stdout).toContain("Dashboard started")
      const state = JSON.parse(readFileSync(join(root, ".av.pid"), "utf-8"))
      pid = state.dashboard
      expect(state.port).toBe(port)
      expect((await command(["status"])).stdout).toContain('"isRunning": true')
      expect((await command(["up", "--dev"])).stdout).toContain("Already running")
      expect((await command(["down"])).stdout).toContain("Stopped")
      expect(existsSync(join(root, ".av.pid"))).toBe(false)
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if (!pid) break
          process.kill(pid, 0)
        } catch {
          pid = undefined
          break
        }
        await delay(100)
      }
      expect(pid).toBeUndefined()
      await expect(command(["status"])).rejects.toThrow()
    } finally {
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          /* already exited */
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
})
