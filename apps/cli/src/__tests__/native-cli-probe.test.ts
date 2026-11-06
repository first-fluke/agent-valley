import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { probeNativeCli } from "../agent-discovery"

async function waitUntilAbsent(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

describe("native CLI metadata process boundary", () => {
  it("preserves stdout, stderr and nonzero authentication-status exit codes", async () => {
    await expect(
      probeNativeCli(
        process.execPath,
        ["-e", 'process.stdout.write("상태");process.stderr.write("signed out");process.exit(3)'],
        {
          env: process.env,
          timeoutMs: 2_000,
          maxOutputBytes: 1024,
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({ exitCode: 3, stdout: "상태", stderr: "signed out" })
  })

  it("does not launch a native command after cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "av-native-probe-"))
    const marker = join(directory, "started")
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(
        probeNativeCli(
          process.execPath,
          ["-e", 'require("node:fs").writeFileSync(process.argv[1],"started")', marker],
          {
            env: process.env,
            timeoutMs: 2_000,
            maxOutputBytes: 1024,
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow("cancelled")
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(["timeout", "abort"])("kills a TERM-ignoring probe and its descendant on %s", async (cause) => {
    const directory = mkdtempSync(join(tmpdir(), "av-native-probe-"))
    const receipt = join(directory, "processes.json")
    const controller = new AbortController()
    let pids: number[] = []
    try {
      const script = [
        'const {spawn}=require("node:child_process");',
        'process.on("SIGTERM",()=>{});',
        'const child=spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'],{stdio:"inherit"});',
        'require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));',
        "setInterval(()=>{},1000);",
      ].join("")
      const started = Date.now()
      const pending = probeNativeCli(process.execPath, ["-e", script, receipt], {
        env: process.env,
        cwd: directory,
        timeoutMs: cause === "timeout" ? 400 : 5_000,
        maxOutputBytes: 1024,
        signal: controller.signal,
      })
      // Attach a handler immediately so a fast timeout cannot become unhandled.
      const outcome = pending.catch((error: unknown) => error)
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          pids = JSON.parse(readFileSync(receipt, "utf8")) as number[]
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      expect(pids).toHaveLength(2)
      if (cause === "abort") controller.abort()
      expect(await outcome).toBeInstanceOf(Error)
      expect(Date.now() - started).toBeLessThan(2_000)
      for (const pid of pids) expect(await waitUntilAbsent(pid)).toBe(true)
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
