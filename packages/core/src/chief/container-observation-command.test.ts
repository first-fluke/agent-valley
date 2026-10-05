import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ContainerObservationCommand, executeContainerCommand } from "./container-observation-command"

const directories: string[] = []
const command: ContainerObservationCommand = { binary: "docker", args: [], timeoutMs: 2_000, maxOutputBytes: 1_024 }
async function fixture(source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "av-container-command-"))
  directories.push(directory)
  await writeFile(join(directory, "docker"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 })
  vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`)
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("bounded native container observation subprocess", () => {
  it("uses argv literally without shell expansion and closes stdin", async () => {
    await fixture(
      'process.stdin.on("end",()=>process.stdout.write(JSON.stringify(process.argv.slice(2))));process.stdin.resume()',
    )
    const output = await executeContainerCommand({ ...command, args: ["literal; echo forbidden", "$(echo forbidden)"] })
    expect(JSON.parse(output.stdout)).toEqual(["literal; echo forbidden", "$(echo forbidden)"])
    expect(output.stderr).toBe("")
  })

  it("caps combined stdout and stderr even when neither stream alone exceeds the limit", async () => {
    await fixture(
      'process.stdout.write("a".repeat(700));process.stderr.write("b".repeat(700));setInterval(()=>{},1000)',
    )
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "output-limit" })
  })

  it("counts output bytes rather than Unicode characters", async () => {
    await fixture('process.stdout.write("😀".repeat(300));setInterval(()=>{},1000)')
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "output-limit" })
  })

  it("kills a hanging CLI on timeout and never returns its stderr", async () => {
    await fixture(
      'process.stderr.write("fixture-credential-must-not-leak");process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    )
    const started = Date.now()
    await expect(executeContainerCommand({ ...command, timeoutMs: 150 })).rejects.toMatchObject({ failure: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("kills an in-flight CLI on abort and handles already cancelled calls without spawn", async () => {
    await fixture("setInterval(()=>{},1000)")
    const controller = new AbortController()
    const running = executeContainerCommand({ ...command, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 40)
    try {
      await expect(running).rejects.toMatchObject({ failure: "cancelled" })
      await expect(executeContainerCommand({ ...command, signal: controller.signal })).rejects.toMatchObject({
        failure: "cancelled",
      })
    } finally {
      clearTimeout(timer)
    }
  })

  it("reports missing CLI and failed commands generically without stderr or secrets", async () => {
    const empty = await mkdtemp(join(tmpdir(), "av-container-missing-"))
    directories.push(empty)
    vi.stubEnv("PATH", empty)
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "missing-cli" })
    await fixture('process.stderr.write("fixture-credential-must-not-leak");process.exitCode=1')
    await expect(executeContainerCommand(command)).rejects.toMatchObject({ failure: "failed" })
    try {
      await executeContainerCommand(command)
    } catch (error) {
      expect(String(error)).not.toContain("fixture-credential")
    }
  })
})
