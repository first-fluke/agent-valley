import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { defaultVerifyExec } from "../orchestrator/verification-gate"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

const LIMIT = 10_240
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }

function startVerifier() {
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
  return defaultVerifyExec("synthetic verifier", "/unused", 5_000)
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function capture(chunks: Buffer[]): Promise<string> {
  const result = startVerifier()
  for (const chunk of chunks) child.stdout.emit("data", chunk)
  child.emit("close", 0)
  return (await result).output
}

describe("verification output streaming", () => {
  test("bounds retained output after every chunk, before the verifier closes", async () => {
    const slice = String.prototype.slice
    const boundInputs: number[] = []
    vi.spyOn(String.prototype, "slice").mockImplementation(function (this: string, start, end) {
      if (start === -LIMIT) boundInputs.push(this.length)
      return slice.call(this, start, end)
    })
    const result = startVerifier()
    const chunk = Buffer.alloc(65_536, "x")
    const samples: number[][] = []
    try {
      for (let index = 0; index < 128; index++) {
        const before = boundInputs.length
        child.stdout.emit("data", chunk)
        samples.push(boundInputs.slice(before))
      }
      expect(samples).toHaveLength(128)
      expect(samples.every((sample) => sample.length > 0)).toBe(true)
      expect(Math.max(...boundInputs)).toBeLessThanOrEqual(LIMIT + chunk.length)
    } finally {
      child.emit("close", 0)
      expect((await result).output).toBe("x".repeat(LIMIT))
    }
  })

  test.each([
    ["CSI", "left\u001b[31mred\u001b[0mright", "leftredright"],
    ["OSC with BEL", "left\u001b]0;hidden\u0007right", "leftright"],
    ["OSC with ST", "left\u001b]0;hidden\u001b\\right", "leftright"],
    ["DCS", "left\u001bPhidden\u001b\\right", "leftright"],
    ["C1 CSI", "left\u009b2Kright", "leftright"],
    ["C1 OSC", "left\u009dhidden\u009cright", "leftright"],
    ["escape intermediate", "left\u001b(Bright", "leftright"],
  ])("removes %s at every byte boundary", async (_name, source, expected) => {
    const bytes = Buffer.from(source)
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(await capture([bytes.subarray(0, cut), bytes.subarray(cut)]), `byte boundary ${cut}`).toBe(expected)
    }
  })

  test("decodes split UTF-8 independently for stdout and stderr", async () => {
    const bytes = Buffer.from("가🙂é")
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(await capture([bytes.subarray(0, cut), bytes.subarray(cut)])).toBe("가🙂é")
    }
    const result = startVerifier()
    const emoji = Buffer.from("🙂")
    child.stdout.emit("data", emoji.subarray(0, 2))
    child.stderr.emit("data", Buffer.from("ERR"))
    child.stdout.emit("data", emoji.subarray(2))
    child.emit("close", 0)
    expect((await result).output).toBe("ERR🙂")
  })

  test("keeps long and unfinished control sequences bounded without swallowing the other stream", async () => {
    const result = startVerifier()
    child.stdout.emit("data", Buffer.from("before\u001b]"))
    const chunk = Buffer.alloc(65_536, "x")
    for (let index = 0; index < 128; index++) child.stdout.emit("data", chunk)
    child.stderr.emit("data", Buffer.from("\u001b[31mERR\u001b[0m"))
    child.stdout.emit("data", Buffer.from("\u0007after\u001b[123;"))
    child.emit("close", 0)
    expect((await result).output).toBe("beforeERRafter")
  })

  test("removes carriage returns and terminal controls while preserving newlines and tabs", async () => {
    expect(await capture([Buffer.from("one\rtwo\bthree\u0000\u007f\u0085\n\tfour")])).toBe("onetwothree\n\tfour")
  })
})
