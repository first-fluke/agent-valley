import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { parseContinuousDecision } from "../chief/continuous-contract"
import { GrokSession } from "./grok-session"
import * as sandboxModule from "./sandbox"

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "av-grok-result-"))
  vi.spyOn(sandboxModule, "planSandboxedSpawn").mockImplementation(async (request) => ({
    command: join(directory, "grok"),
    args: request.args,
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function runFrames(frames: unknown[]) {
  const script = join(directory, "grok")
  writeFileSync(
    script,
    ["#!/bin/bash", ...frames.map((frame) => `echo '${JSON.stringify(frame).replace(/'/g, "'\\''")}'`), "exit 0"].join(
      "\n",
    ),
  )
  chmodSync(script, 0o755)
  const session = new GrokSession()
  const chunks: string[] = []
  const completed: string[] = []
  const errors: string[] = []
  session.on("output", (event) => chunks.push(event.chunk))
  session.on("complete", (event) => completed.push(event.result.output))
  session.on("error", (event) => errors.push(event.error.message))
  await session.start({ type: "grok", timeout: 30, workspacePath: directory })
  await session.execute("Select the next concrete goal")
  return { chunks, completed, errors }
}

describe("Grok native final result", () => {
  test("keeps earlier commentary and tool messages out of a strict Chief decision", async () => {
    const decision = {
      action: "execute",
      goal: "Implement and independently verify the daemon IPC health response.",
      reason: "The product repository has no runtime implementation.",
      evidence: ["SRS section 22 and empty Cargo workspace"],
    }
    const answer = JSON.stringify(decision)
    const result = await runFrames([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I will inspect the repository and requirements first." },
            { type: "tool_use", id: "read-1", name: "read_file", input: { path: "SRS.md" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "specification" }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Private reasoning" },
            { type: "text", text: answer },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: false, result: answer, stop_reason: "end_turn" },
    ])
    expect(result.chunks).toEqual(["I will inspect the repository and requirements first.", answer])
    expect(result.completed.map(parseContinuousDecision)).toEqual([decision])
    expect(result.errors).toEqual([])
  })

  test("preserves a structured answer larger than the progress tail", async () => {
    const answer = JSON.stringify({
      action: "execute",
      goal: "x".repeat(12_000),
      reason: "Implement the goal",
      evidence: ["SRS"],
    })
    const result = await runFrames([{ type: "result", subtype: "success", result: answer, stop_reason: "end_turn" }])
    expect(result.completed).toEqual([answer])
    expect(parseContinuousDecision(answer).action).toBe("execute")
  })

  test.each([
    { type: "error", message: "usage_limit_reached: retry after your allowance resets" },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["usage_limit_reached: retry after your allowance resets"],
    },
  ])("retains provider failure details for handoff: $type", async (frame) => {
    const result = await runFrames([frame])
    expect(result.errors).toEqual(["usage_limit_reached: retry after your allowance resets"])
    expect(result.completed).toEqual([])
  })

  test("rejects a truncated final answer", async () => {
    const result = await runFrames([
      { type: "result", subtype: "success", result: '{"action":', stop_reason: "max_tokens" },
    ])
    expect(result.errors[0]).toContain("max_tokens")
    expect(result.completed).toEqual([])
  })
})
