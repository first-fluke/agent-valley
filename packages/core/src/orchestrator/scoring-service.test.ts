import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildScoringArgs, LlmScoringService } from "./scoring-service"

describe("scoring-service headless Claude args", () => {
  let mockDir: string
  let argsLog: string
  let originalPath: string

  beforeEach(() => {
    mockDir = mkdtempSync(join(tmpdir(), "av-scoring-mock-"))
    argsLog = join(mockDir, "args.json")
    originalPath = process.env.PATH ?? ""
    const script = [
      `#!${process.execPath}`,
      `import { writeFileSync } from "node:fs"`,
      `writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)))`,
      `process.stdout.write("SCORE: 4\\nPHASE: quick\\nEI: 1\\nEO: 1\\nEQ: 0\\nILF: 1\\nEIF: 0\\nREASONING: Simple change\\n")`,
    ].join("\n")
    const bin = join(mockDir, "claude")
    writeFileSync(bin, script, "utf8")
    chmodSync(bin, 0o755)
    process.env.PATH = `${mockDir}:${originalPath}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(mockDir, { recursive: true, force: true })
  })

  it("isolates MCP servers and hooks in buildScoringArgs", () => {
    expect(buildScoringArgs("claude", "hello")).toEqual([
      "--print",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "-p",
      "hello",
    ])
    expect(buildScoringArgs("haiku", "hello")).toEqual([
      "--print",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "--model",
      "haiku",
      "-p",
      "hello",
    ])
  })

  it("passes MCP and hook isolation flags when spawning claude", async () => {
    const service = new LlmScoringService("haiku")
    const analysis = await service.analyze("Fix bug", "Details")
    expect(analysis).toMatchObject({
      score: 4,
      phase: "quick",
      functionTypes: { ei: 1, eo: 1, eq: 0, ilf: 1, eif: 0 },
    })
    const spawnedArgs = JSON.parse(readFileSync(argsLog, "utf8")) as string[]
    expect(spawnedArgs.slice(0, 7)).toEqual([
      "--print",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "--model",
      "haiku",
    ])
  })
})
