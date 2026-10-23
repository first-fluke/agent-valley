import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { CodexSession } from "../sessions/codex-session"
import * as sandboxModule from "../sessions/sandbox"

describe("Codex external sandbox policy", () => {
  let directory: string
  let session: CodexSession | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "av-codex-sandbox-policy-"))
  })

  afterEach(async () => {
    await session?.dispose()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  function prepare(sandboxed: boolean, rejectExternal = false, platform: NodeJS.Platform = "darwin") {
    const requests = join(directory, "requests.jsonl")
    const script = join(directory, "app-server.mjs")
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const requests = ${JSON.stringify(requests)};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(requests, JSON.stringify(message) + '\\n');
  if (!message.id) continue;
  if (message.method === 'turn/start' && message.params.sandboxPolicy?.type === 'externalSandbox' && ${rejectExternal}) {
    console.log(JSON.stringify({ id: message.id, error: { code: -32602, message: 'External sandbox policy unsupported' } }));
    continue;
  }
  const result = message.method === 'thread/start' ? { thread: { id: 'thread-policy' } } : message.method === 'turn/start' ? { turn: { id: 'turn-policy' } } : {};
  console.log(JSON.stringify({ id: message.id, result }));
  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-policy', turn: { id: 'turn-policy', status: 'completed' } } }));
  }
}
`,
    )
    vi.spyOn(sandboxModule, "planSandboxedSpawn").mockResolvedValue({
      command: process.execPath,
      args: [script],
      sandboxed,
      platform,
      networkAllowlist: [],
    })
    session = new CodexSession()
    return () =>
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
  }

  test("delegates tool containment to an enforced outer OS sandbox", async () => {
    const requests = prepare(true)
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session?.execute("Read the workspace")

    expect(requests().find((request) => request.method === "turn/start")?.params.sandboxPolicy).toEqual({
      type: "externalSandbox",
      networkAccess: "restricted",
    })
    expect(sandboxModule.planSandboxedSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "codex", workspacePath: directory }),
    )
  })

  test("keeps native workspace enforcement when the outer planner reports no sandbox", async () => {
    const requests = prepare(false)
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session?.execute("Read the workspace")

    const messages = requests()
    expect(messages.find((request) => request.method === "thread/start")?.params.sandbox).toBe("workspace-write")
    expect(messages.find((request) => request.method === "turn/start")?.params.sandboxPolicy).toBeUndefined()
  })

  test("preserves the native tool policy on Linux", async () => {
    const requests = prepare(true, false, "linux")
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session?.execute("Read the workspace")

    expect(requests().find((request) => request.method === "turn/start")?.params.sandboxPolicy).toBeUndefined()
  })

  test("clears the outer sandbox receipt when the same session restarts without confinement", async () => {
    const requests = prepare(true)
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session?.execute("First execution")
    await session?.dispose()
    vi.mocked(sandboxModule.planSandboxedSpawn).mockImplementation(async () => ({
      command: process.execPath,
      args: [join(directory, "app-server.mjs")],
      sandboxed: false,
      platform: "darwin",
      networkAllowlist: [],
    }))
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })
    await session?.execute("Second execution")

    const turns = requests().filter((request) => request.method === "turn/start")
    expect(turns).toHaveLength(2)
    expect(turns[0].params.sandboxPolicy.type).toBe("externalSandbox")
    expect(turns[1].params.sandboxPolicy).toBeUndefined()
  })

  test("surfaces an unsupported external policy without retrying with weaker containment", async () => {
    const requests = prepare(true, true)
    await session?.start({ type: "codex", timeout: 10, workspacePath: directory })

    await expect(session?.execute("Read the workspace")).rejects.toThrow("External sandbox policy unsupported")
    const turns = requests().filter((request) => request.method === "turn/start")
    expect(turns).toHaveLength(1)
    expect(turns[0].params.sandboxPolicy.type).toBe("externalSandbox")
  })
})
