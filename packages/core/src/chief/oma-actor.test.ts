import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { prepareOmaActor } from "./oma-actor"

let workspace: string
let outside: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chief-oma-actor-"))
  outside = await mkdtemp(join(tmpdir(), "chief-oma-actor-outside-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function skill(name: string, body = `Body for ${name}.`): Promise<string> {
  const directory = join(workspace, ".agents", "skills", name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "SKILL.md")
  await writeFile(path, `---\nname: ${name}\ndescription: Instructions for ${name}.\n---\n${body}`)
  return realpath(path)
}

async function profile(name: string, skills: string[], body = `Agent instructions for ${name}.`): Promise<string> {
  const directory = join(workspace, ".agents", "agents")
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}.md`)
  await writeFile(path, `---\nname: ${name}\nskills: ${JSON.stringify(skills)}\n---\n${body}`)
  return realpath(path)
}

describe("installed OMA Actor preparation", () => {
  it("requires an explicit assigned skill and an installed matching profile", async () => {
    await expect(prepareOmaActor(workspace, [])).rejects.toThrow("requires an assigned skill")
    await skill("oma-backend")
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("Install the OMA harness")
    await profile("frontend-engineer", ["oma-frontend"])
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("No installed OMA agent profile matches")
  })

  it("selects maximum overlap with lexical ties and binds exact agent and all declared skill bodies", async () => {
    for (const name of ["oma-backend", "oma-db", "oma-qa", "oma-docs"]) await skill(name, `Exact ${name} token.\r\n`)
    await profile("narrow", ["oma-backend"])
    await profile("z-specialist", ["oma-backend", "oma-db"])
    const path = await profile("a-specialist", ["oma-backend", "oma-db", "oma-qa"], "Exact agent definition.\r\n")
    const prepared = await prepareOmaActor(workspace, ["oma-db", "oma-docs", "oma-backend", "oma-db"])
    expect(prepared.agentId).toBe("a-specialist")
    expect(prepared.skills).toEqual(["oma-backend", "oma-db", "oma-docs", "oma-qa"])
    expect(prepared.guidance).toContain(`Source: ${path}\n${await readFile(path, "utf8")}`)
    for (const name of prepared.skills) {
      const skillPath = await realpath(join(workspace, ".agents", "skills", name, "SKILL.md"))
      expect(prepared.guidance).toContain(`Source: ${skillPath}\n${await readFile(skillPath, "utf8")}`)
      expect(prepared.guidance.match(new RegExp(`## Skill ${name}`, "g"))).toHaveLength(1)
    }
    expect(prepared.guidance).not.toContain("Agent instructions for narrow")
    expect(prepared.digest).toBe(createHash("sha256").update(prepared.guidance).digest("hex"))
    expect((await prepareOmaActor(workspace, ["oma-docs", "oma-backend", "oma-db"])).digest).toBe(prepared.digest)
  })

  it("supports custom skills only when explicitly assigned and declared by the matching profile", async () => {
    await skill("oma-backend")
    await skill("custom-guide", "Explicit custom instructions.")
    await profile("unassociated", ["oma-backend"])
    await expect(prepareOmaActor(workspace, ["oma-backend", "custom-guide"])).rejects.toThrow(
      "custom skills must be declared",
    )
    await profile("associated", ["oma-backend", "custom-guide"])
    const prepared = await prepareOmaActor(workspace, ["custom-guide"])
    expect(prepared.agentId).toBe("associated")
    expect(prepared.guidance).toContain("Explicit custom instructions.")
    expect(prepared.guidance).toContain("Body for oma-backend.")
  })

  it.each(["oma-backend", "oma-missing"])("rejects missing selected or profile-declared skill %s", async (missing) => {
    await skill("oma-backend")
    await profile("backend-engineer", ["oma-backend", "oma-missing"])
    if (missing === "oma-backend") await rm(join(workspace, ".agents/skills/oma-backend"), { recursive: true })
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow(
      `OMA skill ${missing} is missing or invalid`,
    )
  })

  it.each(["../escape", "/absolute", "oma-../escape"])("rejects traversal in selected skill %s", async (name) => {
    await expect(prepareOmaActor(workspace, [name])).rejects.toThrow("Invalid skill name")
  })

  it.each([
    "No frontmatter.",
    "---\nname: [\nskills: [oma-backend]\n---\nBody.",
    "---\nname: wrong\nskills: [oma-backend]\n---\nBody.",
    "---\nname: backend-engineer\nname: backend-engineer\nskills: [oma-backend]\n---\nBody.",
    "---\nname: backend-engineer\nskills: &skills [oma-backend]\ncopy: *skills\n---\nBody.",
    "---\nname: backend-engineer\nskills: !unknown [oma-backend]\n---\nBody.",
    "---\nname: backend-engineer\nskills: []\n---\nBody.",
    "---\nname: backend-engineer\nskills: [../escape]\n---\nBody.",
    "---\nname: backend-engineer\nskills: [oma-backend, oma-backend]\n---\nBody.",
    "---\nname: backend-engineer\nskills: [oma-backend]\n---\n",
  ])("rejects malformed installed profile %# before preparing Actor guidance", async (source) => {
    await skill("oma-backend")
    const path = await profile("backend-engineer", ["oma-backend"])
    await writeFile(path, source)
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("Restore YAML frontmatter")
  })

  it("rejects escaping profile roots and leaf symlinks", async () => {
    await skill("oma-backend")
    await symlink(outside, join(workspace, ".agents/agents"))
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("escapes the mission worktree")
    await rm(join(workspace, ".agents/agents"))
    const path = await profile("backend-engineer", ["oma-backend"])
    await writeFile(join(outside, "backend.md"), await readFile(path))
    await rm(path)
    await symlink(join(outside, "backend.md"), path)
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("escapes .agents/agents")
  })

  it("rejects unreadable and nonregular profiles", async () => {
    await skill("oma-backend")
    const path = await profile("backend-engineer", ["oma-backend"])
    await chmod(path, 0)
    try {
      if (process.getuid?.() !== 0)
        await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("unreadable")
    } finally {
      await chmod(path, 0o600)
    }
    await rm(path)
    await mkdir(path)
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("must be a regular file")
  })

  it("bounds profile files and combined injected instructions", async () => {
    await skill("oma-backend", "한".repeat(80_000))
    const path = await profile("backend-engineer", ["oma-backend"], "x".repeat(64_001))
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("exceeds 64 KB")
    await profile("backend-engineer", ["oma-backend"], "x".repeat(20_000))
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("exceed 256 KB")
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(20_000)
  })

  it("bounds the installed profile catalog and cumulative profile source bytes", async () => {
    await skill("oma-backend")
    for (let index = 0; index < 101; index++) await profile(`worker-${index}`, ["oma-backend"])
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("more than 100 OMA agent profiles")
    await rm(join(workspace, ".agents/agents"), { recursive: true })
    for (let index = 0; index < 17; index++) await profile(`worker-${index}`, ["oma-backend"], "x".repeat(60_000))
    await expect(prepareOmaActor(workspace, ["oma-backend"])).rejects.toThrow("profiles exceed 1 MB")
  })
})
