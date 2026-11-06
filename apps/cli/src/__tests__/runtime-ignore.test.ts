import { execFile } from "node:child_process"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MissionJobs } from "../mission-jobs"
import { setupNoninteractive } from "../setup/noninteractive"
import { noninteractiveFixture } from "./setup/noninteractive-fixture"

const execute = promisify(execFile)
let fixture: ReturnType<typeof noninteractiveFixture>

beforeEach(() => {
  fixture = noninteractiveFixture()
})
afterEach(() => {
  fixture.cleanup()
})

async function ignored(root: string) {
  await execute("git", ["check-ignore", "--no-index", "--quiet", "--", ".agent-valley/operations/test.json"], {
    cwd: root,
  })
}

describe("AV runtime exclusion at setup and startup", () => {
  it("saves effective rules for both configuration and target repositories without launching a provider", async () => {
    const project = fixture.deps.projectRoot
    const projectIgnore = join(project, ".gitignore")
    const workspaceIgnore = join(fixture.workspace, ".gitignore")
    await writeFile(projectIgnore, "# Existing user rule\ncustom/")
    await writeFile(workspaceIgnore, ".agent-valley/\n!.agent-valley/\n")

    const options = { yes: true, actor: "codex", workspace: fixture.workspace, oma: "skip" } as const
    const first = await setupNoninteractive(options, fixture.deps)
    expect(first.status, first.error).toBe("ready")
    await ignored(project)
    await ignored(fixture.workspace)
    const beforeRepeat = [await readFile(projectIgnore, "utf8"), await readFile(workspaceIgnore, "utf8")]
    expect(beforeRepeat[0]).toBe("# Existing user rule\ncustom/\n.agent-valley/\n")
    expect(beforeRepeat[1]).toBe(".agent-valley/\n!.agent-valley/\n.agent-valley/\n")

    expect((await setupNoninteractive(options, fixture.deps)).status).toBe("ready")
    expect([await readFile(projectIgnore, "utf8"), await readFile(workspaceIgnore, "utf8")]).toEqual(beforeRepeat)
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
  })

  it("still excludes target runtime data when its configuration directory is outside Git", async () => {
    await rm(join(fixture.deps.projectRoot, ".git"), { recursive: true })

    const result = await setupNoninteractive(
      { yes: true, actor: "codex", workspace: fixture.workspace, oma: "skip" },
      fixture.deps,
    )

    expect(result.status, result.error).toBe("ready")
    await ignored(fixture.workspace)
    await expect(access(join(fixture.deps.projectRoot, ".gitignore"))).rejects.toThrow()
  })

  it("retains rules legitimately added by OMA before the atomic setup save", async () => {
    const path = join(fixture.workspace, ".gitignore")
    fixture.deps.prepareOma.mockImplementation(async () => {
      await writeFile(path, "# OMA runtime\n.agents/state/\n")
      return { success: true, message: "Prepared fixture OMA rules" }
    })

    const result = await setupNoninteractive({ yes: true, actor: "codex", workspace: fixture.workspace }, fixture.deps)

    expect(result.status, result.error).toBe("ready")
    expect(await readFile(path, "utf8")).toBe("# OMA runtime\n.agents/state/\n.agent-valley/\n")
    await ignored(fixture.workspace)
  })

  it("leaves ignore files untouched when setup detects a conflicting integration before provisioning", async () => {
    fixture.write(join(fixture.workspace, ".mcp.json"), JSON.stringify({ mcpServers: { av: { command: "unowned" } } }))

    const result = await setupNoninteractive(
      { yes: true, actor: "codex", workspace: fixture.workspace, oma: "skip" },
      fixture.deps,
    )

    expect(result.status).toBe("failed")
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
    expect(fixture.deps.applyFiles).not.toHaveBeenCalled()
    await expect(access(join(fixture.deps.projectRoot, ".gitignore"))).rejects.toThrow()
    await expect(access(join(fixture.workspace, ".gitignore"))).rejects.toThrow()
  })

  it("excludes the actual queue root before a worker startup can fail", async () => {
    const project = fixture.deps.projectRoot
    const jobs = new MissionJobs(project)

    await expect(
      jobs.locked(async () => {
        await ignored(project)
        await writeFile(join(project, ".agent-valley/control/jobs", "attempt.json"), "{}")
        throw new Error("Worker unavailable before launch")
      }),
    ).rejects.toThrow("Worker unavailable before launch")

    await ignored(project)
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    await expect(access(join(fixture.workspace, ".gitignore"))).rejects.toThrow()
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
  })

  it("does not add Git rules while only listing saved jobs", async () => {
    expect(await new MissionJobs(fixture.deps.projectRoot).list()).toEqual([])
    await expect(access(join(fixture.deps.projectRoot, ".gitignore"))).rejects.toThrow()
  })
})
