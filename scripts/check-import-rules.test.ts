import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const { collectViolations } = (await import("./check-import-rules.mjs")) as {
  collectViolations: (root?: string) => string[]
}

const directories: string[] = []

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-import-rules-"))
  directories.push(root)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("import rule gate", () => {
  test("reports domain code importing the application layer", async () => {
    const root = await fixture({
      "packages/core/src/domain/model.ts": 'import { core } from "../orchestrator/core"\nexport const model = core\n',
      "packages/core/src/orchestrator/core.ts": "export const core = 1\n",
    })

    expect(collectViolations(root)).toEqual([
      "domain-purity\tpackages/core/src/domain/model.ts\tpackages/core/src/orchestrator/core",
    ])
  })

  test("reports adapters importing the application layer", async () => {
    const root = await fixture({
      "packages/core/src/sessions/adapters/runner.ts":
        'import { service } from "../../orchestrator/agent-runner"\nexport const runner = service\n',
      "packages/core/src/orchestrator/agent-runner.ts": "export const service = 1\n",
    })

    expect(collectViolations(root)).toEqual([
      "adapter-isolation\tpackages/core/src/sessions/adapters/runner.ts\tpackages/core/src/orchestrator/agent-runner",
    ])
  })

  test("allows domain types and adapter helpers", async () => {
    const root = await fixture({
      "packages/core/src/domain/issue.ts": 'import type { Port } from "./ports/tracker"\nexport type Issue = Port\n',
      "packages/core/src/domain/ports/tracker.ts": "export interface Port {}\n",
      "packages/core/src/tracker/adapters/github.ts":
        'import { helper } from "../helper"\nexport const value = helper\n',
      "packages/core/src/tracker/helper.ts": "export const helper = 1\n",
    })

    expect(collectViolations(root)).toEqual([])
  })

  test("rejects framework packages in domain contracts", async () => {
    const root = await fixture({
      "packages/core/src/domain/ports/runner.ts":
        'import type { Task } from "@a2a-js/sdk"\nexport type Result = Task\n',
      "packages/core/src/domain/state.ts": 'export { StateGraph } from "@langchain/langgraph"\n',
    })

    expect(collectViolations(root)).toEqual([
      "domain-external\tpackages/core/src/domain/ports/runner.ts\t@a2a-js/sdk",
      "domain-external\tpackages/core/src/domain/state.ts\t@langchain/langgraph",
      "framework-boundary\tpackages/core/src/domain/state.ts\t@langchain/langgraph",
    ])
  })

  test("confines LangChain to the coordinator routing adapter", async () => {
    const root = await fixture({
      "packages/core/src/chief/coordinator-graph.ts":
        'import { StateGraph } from "@langchain/langgraph"\nexport const Graph = StateGraph\n',
      "packages/core/src/chief/store.ts": 'export const checkpoint = import("@langchain/langgraph/checkpoint")\n',
    })

    expect(collectViolations(root)).toEqual([
      "framework-boundary\tpackages/core/src/chief/store.ts\t@langchain/langgraph/checkpoint",
    ])
  })
})
