import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { CodexSession } from "../sessions/codex-session"
import * as sandbox from "../sessions/sandbox"

describe("Codex cancellation completion", () => {
  let directory: string
  let session: CodexSession | undefined
  let expectedDisposalError: Error | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "av-codex-cancel-"))
    expectedDisposalError = undefined
  })

  afterEach(async () => {
    const errors: unknown[] = []
    try {
      if (expectedDisposalError) await expect(session?.dispose()).rejects.toBe(expectedDisposalError)
      else await session?.dispose()
    } catch (error) {
      errors.push(error)
    }
    const pidFile = join(directory, "owned-tool-pid")
    if (existsSync(pidFile) && !existsSync(join(directory, "shutdown-joined"))) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error)
      }
    }
    vi.restoreAllMocks()
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, "Codex cancellation fixture cleanup failed")
  })

  async function start(behavior: "delayed" | "before-ack" | "exit" | "shutdown" | "stubborn" | "crash-with-tool") {
    const script = join(directory, "app-server.mjs")
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const directory = ${JSON.stringify(directory)};
const behavior = ${JSON.stringify(behavior)};
if (behavior === 'stubborn') setInterval(() => {}, 100);
let tool;
const send = message => console.log(JSON.stringify(message));
const terminal = (threadId, id) => send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'interrupted' } } });
const finish = () => {
  writeFileSync(directory + '/cleanup-finished', 'stopped');
  terminal('thread-cancel', 'turn-cancel');
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  if (['shutdown', 'crash-with-tool'].includes(behavior) && request.method === 'turn/start') {
    tool = spawn(process.execPath, ['-e', "setTimeout(() => {}, 2000)"], { detached: true, stdio: 'ignore' });
    writeFileSync(directory + '/owned-tool-pid', String(tool.pid));
  }
  if (request.method === 'turn/interrupt') {
    if (behavior === 'before-ack') finish();
    send({ id: request.id, result: {} });
    terminal('other-thread', 'turn-cancel');
    terminal('thread-cancel', 'other-turn');
    send({ method: 'probe/interrupt-ack', params: { threadId: 'thread-cancel' } });
    if (behavior === 'exit') process.exit(0);
    if (behavior === 'delayed') {
      const timer = setInterval(() => {
        if (existsSync(directory + '/release-cleanup')) {
          clearInterval(timer);
          finish();
        }
      }, 5);
    }
    continue;
  }
  const result = request.method === 'thread/start'
    ? { thread: { id: 'thread-cancel' } }
    : request.method === 'turn/start' ? { turn: { id: 'turn-cancel' } } : {};
  send({ id: request.id, result });
  if (behavior === 'crash-with-tool' && request.method === 'turn/start') setImmediate(() => process.exit(1));
}
if (tool) {
  const closed = once(tool, 'close');
  tool.kill('SIGKILL');
  await closed;
  writeFileSync(directory + '/shutdown-joined', 'owned command stopped before server exit');
}
`,
    )
    vi.spyOn(sandbox, "planSandboxedSpawn").mockResolvedValue({
      command: process.execPath,
      args: [script],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    })
    session = new CodexSession()
    await session.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session.execute("Controlled cancellation fixture")
    return session
  }

  test("keeps cancellation pending after the RPC acknowledgement and unrelated terminal events", async () => {
    const running = await start("delayed")
    let acknowledge!: () => void
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    running.on("heartbeat", acknowledge)
    let cancelled = false
    const cancelling = running.cancel().then(() => {
      cancelled = true
    })
    await acknowledged
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(cancelled).toBe(false)
      expect(existsSync(join(directory, "cleanup-finished"))).toBe(false)
    } finally {
      writeFileSync(join(directory, "release-cleanup"), "release")
      await cancelling
    }
    expect(existsSync(join(directory, "cleanup-finished"))).toBe(true)
    expect(cancelled).toBe(true)
  })

  test("does not miss the matching turn terminal event when it arrives before the interrupt reply", async () => {
    const running = await start("before-ack")
    await running.cancel()
    expect(existsSync(join(directory, "cleanup-finished"))).toBe(true)
  })

  test("rejects unconfirmed cancellation when the server exits after acknowledging interruption", async () => {
    const running = await start("exit")
    await expect(running.cancel()).rejects.toThrow(/exited|completion/)
    try {
      await running.dispose()
      expect.fail("Unexpected server exit must retain cleanup uncertainty")
    } catch (error) {
      expectedDisposalError = error as Error
      expect(expectedDisposalError.message).toContain("exited before graceful shutdown")
    }
  })

  test("shuts down the app-server through EOF before confirming disposal of its separate command", async () => {
    const running = await start("shutdown")
    await running.dispose()
    expect(existsSync(join(directory, "shutdown-joined"))).toBe(true)
    const pid = Number(readFileSync(join(directory, "owned-tool-pid"), "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("joins graceful command cleanup when kill is followed by dispose", async () => {
    const running = await start("shutdown")
    await running.kill()
    await running.dispose()
    expect(existsSync(join(directory, "shutdown-joined"))).toBe(true)
  })

  test("retains cleanup uncertainty after bounded EOF shutdown requires a forced kill", async () => {
    const running = await start("stubborn")
    try {
      await running.kill()
      expect.fail("A forced fallback must not certify graceful command cleanup")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expectedDisposalError = error as Error
      expect(expectedDisposalError.message).toContain("graceful shutdown was not confirmed")
    }
    expect(running.isAlive()).toBe(false)
    await expect(running.dispose()).rejects.toBe(expectedDisposalError)
  })

  test("retains uncertainty when the server already exited with a detached tool", async () => {
    const running = await start("crash-with-tool")
    await vi.waitFor(() => expect(running.isAlive()).toBe(false))
    let failure: unknown
    try {
      await running.dispose()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expectedDisposalError = failure as Error
    expect(expectedDisposalError.message).toContain("exited before graceful shutdown")
    const pid = Number(readFileSync(join(directory, "owned-tool-pid"), "utf8"))
    expect(() => process.kill(pid, 0)).not.toThrow()
  })
})
