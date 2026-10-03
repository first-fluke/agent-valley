import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverMissionSkills, loadMissionSkillBodies, prepareMissionSkills, validateMissionSkills } from "./skills"

let workspace: string
let outside: string

function first<T>(values: T[]): T {
  const value = values[0]
  if (!value) throw new Error("Expected a populated test fixture.")
  return value
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "chief-skills-"))
  outside = await mkdtemp(join(tmpdir(), "chief-skills-outside-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function install(
  name: string,
  source = `---\nname: ${name}\ndescription: Guides ${name}.\n---\nInstructions for ${name}.`,
): Promise<string> {
  const directory = join(workspace, ".agents", "skills", name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "SKILL.md")
  await writeFile(path, source)
  return realpath(path)
}

describe("mission OMA skill discovery", () => {
  it("discovers every actually installed OMA skill, including arbitrary new names, without invented entries", async () => {
    const names = ["oma-video-maker", "oma-unseen-specialist", "oma-backend"]
    for (const name of names) await install(name)
    await install("custom-explicit-skill")
    await mkdir(join(workspace, ".agents/skills/oma-missing-file"))
    const catalog = await discoverMissionSkills(workspace)
    expect(catalog.map((skill) => skill.name)).toEqual([...names].sort())
    for (const skill of catalog) {
      expect(skill.path).toBe(await realpath(join(workspace, ".agents/skills", skill.name, "SKILL.md")))
      expect(skill.description).toBe(`Guides ${skill.name}.`)
    }
  })

  it("handles a missing root and a root that is not a directory", async () => {
    expect(await discoverMissionSkills(workspace)).toEqual([])
    await mkdir(join(workspace, ".agents"))
    await writeFile(join(workspace, ".agents/skills"), "ordinary file")
    expect(await discoverMissionSkills(workspace)).toEqual([])
  })

  it("does not borrow a harness from outside the current target worktree", async () => {
    await mkdir(join(workspace, ".agents"))
    await mkdir(join(outside, "oma-outside"))
    await writeFile(
      join(outside, "oma-outside/SKILL.md"),
      "---\nname: oma-outside\ndescription: Outside.\n---\nOutside body.",
    )
    await symlink(outside, join(workspace, ".agents/skills"))
    expect(await discoverMissionSkills(workspace)).toEqual([])
    await expect(loadMissionSkillBodies(workspace, ["oma-outside"])).rejects.toThrow("escapes the mission worktree")
  })

  it("rejects external directory and leaf symlinks while retaining valid installed entries", async () => {
    await install("oma-safe")
    await mkdir(join(outside, "oma-external-dir"))
    await writeFile(
      join(outside, "oma-external-dir/SKILL.md"),
      "---\nname: oma-external-dir\ndescription: Outside.\n---\nOutside body.",
    )
    await symlink(join(outside, "oma-external-dir"), join(workspace, ".agents/skills/oma-external-dir"))
    await mkdir(join(workspace, ".agents/skills/oma-external-leaf"))
    await writeFile(join(outside, "leaf.md"), "---\nname: oma-external-leaf\ndescription: Outside.\n---\nOutside body.")
    await symlink(join(outside, "leaf.md"), join(workspace, ".agents/skills/oma-external-leaf/SKILL.md"))
    expect((await discoverMissionSkills(workspace)).map((skill) => skill.name)).toEqual(["oma-safe"])
    await expect(loadMissionSkillBodies(workspace, ["oma-external-leaf"])).rejects.toThrow(
      "escapes the skill directory",
    )
  })

  it("normalizes bounded YAML descriptions and supports CRLF frontmatter", async () => {
    await install(
      "oma-prose",
      "---\r\nname: oma-prose\r\ndescription: >-\r\n  Write a plain\r\n  readable report.\r\n---\r\nFull instructions.",
    )
    expect((await discoverMissionSkills(workspace))[0]?.description).toBe("Write a plain readable report.")
  })

  it.each([
    ["missing-frontmatter", "No metadata."],
    ["malformed", "---\nname: [\ndescription: Broken.\n---\nBody."],
    ["duplicate", "---\nname: oma-duplicate\nname: oma-duplicate\ndescription: Duplicate.\n---\nBody."],
    ["alias", "---\nname: oma-alias\ndescription: &text Words.\ncopy: *text\n---\nBody."],
    ["tag", "---\nname: oma-tag\ndescription: !unknown Words.\n---\nBody."],
    ["mismatch", "---\nname: oma-different\ndescription: Wrong name.\n---\nBody."],
    ["not-string", "---\nname: oma-not-string\ndescription: 12\n---\nBody."],
    ["empty", "---\nname: oma-empty\ndescription: ''\n---\nBody."],
    ["oversized-description", `---\nname: oma-oversized-description\ndescription: ${"x".repeat(1_001)}\n---\nBody.`],
    [
      "oversized-metadata",
      `---\nname: oma-oversized-metadata\ndescription: Short.\nextra: ${"x".repeat(16_384)}\n---\nBody.`,
    ],
    ["oversized-file", `---\nname: oma-oversized-file\ndescription: Short.\n---\n${"x".repeat(256_001)}`],
  ])("omits %s metadata without blocking readable installed skills", async (suffix, source) => {
    await install(`oma-${suffix}`, source)
    await install("oma-valid")
    expect((await discoverMissionSkills(workspace)).map((skill) => skill.name)).toEqual(["oma-valid"])
  })

  it("skips unreadable files and nonregular SKILL.md entries", async () => {
    const unreadable = await install("oma-unreadable")
    await chmod(unreadable, 0)
    await mkdir(join(workspace, ".agents/skills/oma-directory/SKILL.md"), { recursive: true })
    try {
      const catalog = await discoverMissionSkills(workspace)
      expect(catalog.some((skill) => skill.name === "oma-directory")).toBe(false)
      if (process.getuid?.() !== 0) expect(catalog.some((skill) => skill.name === "oma-unreadable")).toBe(false)
    } finally {
      await chmod(unreadable, 0o600)
    }
  })

  it("fails actionably instead of silently dropping a catalog larger than the persisted limit", async () => {
    for (let index = 0; index < 101; index++) await install(`oma-specialist-${index}`)
    await expect(discoverMissionSkills(workspace)).rejects.toThrow("more than 100 OMA skills")
  })
})

describe("mission skill bodies and persisted catalog boundaries", () => {
  it("loads only selected bodies using each actual verified guide path", async () => {
    const selectedPath = await install(
      "oma-selected",
      "---\nname: oma-selected\ndescription: Selected.\n---\nSelected body token.",
    )
    await install(
      "oma-unselected",
      "---\nname: oma-unselected\ndescription: Unselected.\n---\nPrivate unselected body token.",
    )
    const catalog = await discoverMissionSkills(workspace)
    const content = await loadMissionSkillBodies(workspace, ["oma-selected"], catalog)
    expect(content).toContain(`Source: ${selectedPath}`)
    expect(content).toContain("Selected body token.")
    expect(content).not.toContain("Private unselected body token.")
    expect(await loadMissionSkillBodies(workspace, [], catalog)).toBe("")
  })

  it("preserves explicit custom skills while automatic selection requires the catalog", async () => {
    await install("custom-guide", "Explicit custom instructions without frontmatter.")
    expect(await loadMissionSkillBodies(workspace, ["custom-guide"])).toContain("Explicit custom instructions")
    await expect(loadMissionSkillBodies(workspace, ["custom-guide"], [])).rejects.toThrow(
      "absent from the verified mission catalog",
    )
    await expect(loadMissionSkillBodies(workspace, ["../escape"])).rejects.toThrow("Invalid skill name")
  })

  it.each(["../escape.md", "/outside/SKILL.md", "different-local-file"])(
    "rejects injected persisted path %s even when nothing is selected",
    async (injected) => {
      const actual = await install("oma-selected")
      const catalog = await discoverMissionSkills(workspace)
      first(catalog).path = injected === "different-local-file" ? join(workspace, "outside.md") : injected
      await writeFile(join(workspace, "outside.md"), "Other local body.")
      expect(first(catalog).path).not.toBe(actual)
      await expect(loadMissionSkillBodies(workspace, [], catalog)).rejects.toThrow("no longer matches this worktree")
    },
  )

  it("rejects metadata drift, duplicate names, removed skills, and catalog overflow on resume", async () => {
    const path = await install("oma-selected")
    const catalog = await discoverMissionSkills(workspace)
    await expect(validateMissionSkills(workspace, [...catalog, ...catalog])).rejects.toThrow("repeats a name")
    await expect(
      validateMissionSkills(
        workspace,
        Array.from({ length: 101 }, () => first(catalog)),
      ),
    ).rejects.toThrow("exceeds 100 entries")
    await writeFile(path, "---\nname: oma-selected\ndescription: Changed.\n---\nNew body.")
    await expect(validateMissionSkills(workspace, catalog)).rejects.toThrow("no longer matches this worktree")
    await rm(join(workspace, ".agents"), { recursive: true })
    await expect(validateMissionSkills(workspace, catalog)).rejects.toThrow("Install its OMA harness")
  })

  it("rechecks a symlink that was swapped after discovery before reading any selected body", async () => {
    const path = await install("oma-selected")
    const catalog = await discoverMissionSkills(workspace)
    await rm(path)
    await writeFile(join(outside, "replacement.md"), "External replacement body.")
    await symlink(join(outside, "replacement.md"), path)
    await expect(loadMissionSkillBodies(workspace, ["oma-selected"], catalog)).rejects.toThrow(
      "no longer matches this worktree",
    )
  })

  it("bounds the combined selected body size by bytes and deduplicates repeated selection", async () => {
    await install("first", "한".repeat(50_000))
    await install("second", "한".repeat(50_000))
    await expect(loadMissionSkillBodies(workspace, ["first", "second"])).rejects.toThrow("Select fewer skills")
    const once = await loadMissionSkillBodies(workspace, ["first", "first"])
    expect(once.match(/## Skill first/g)).toHaveLength(1)
  })
})

describe("installed harness preparation", () => {
  it("copies uncommitted installed skills and shared resources verbatim, preserving existing worktree files", async () => {
    const path = await install("oma-custom")
    await mkdir(join(workspace, ".agents/skills/_shared/core"), { recursive: true })
    await writeFile(join(workspace, ".agents/skills/_shared/core/execution-policy.md"), "Shared reference bytes.\n")
    await mkdir(join(workspace, ".agents/skills/oma-custom/resources"))
    await writeFile(join(workspace, ".agents/skills/oma-custom/resources/guide.md"), "Selected guide bytes.\n")
    await mkdir(join(outside, ".agents/skills/oma-custom/resources"), { recursive: true })
    const existing = join(outside, ".agents/skills/oma-custom/resources/guide.md")
    await writeFile(existing, "Committed target guide.\n")
    const original = await readFile(path)
    await prepareMissionSkills(workspace, outside)
    const catalog = await discoverMissionSkills(outside)
    expect(catalog.map((skill) => skill.name)).toEqual(["oma-custom"])
    expect(first(catalog).path).toBe(await realpath(join(outside, ".agents/skills/oma-custom/SKILL.md")))
    expect(await readFile(first(catalog).path)).toEqual(original)
    expect(await readFile(existing, "utf8")).toBe("Committed target guide.\n")
    expect(await readFile(join(outside, ".agents/skills/_shared/core/execution-policy.md"), "utf8")).toBe(
      "Shared reference bytes.\n",
    )
    expect(await readFile(path)).toEqual(original)
    await prepareMissionSkills(workspace, outside)
    await prepareMissionSkills(workspace, workspace)
    expect(await readFile(existing, "utf8")).toBe("Committed target guide.\n")
  })

  it("omits local secrets, generated outputs, external symlinks, and nonregular resources", async () => {
    await install("oma-safe")
    for (const name of [
      ".env",
      ".env.local",
      "credentials.json",
      "auth.json",
      "settings.yaml",
      "av.yaml",
      "secret.key",
      "oma-config.local.yaml",
    ])
      await writeFile(join(workspace, ".agents/skills", name), "Synthetic private configuration.")
    for (const name of ["state", "results", "node_modules"]) {
      await mkdir(join(workspace, ".agents/skills", name))
      await writeFile(join(workspace, ".agents/skills", name, "artifact.md"), "Generated output.")
    }
    await writeFile(join(workspace, "external.md"), "External body.")
    await symlink(join(workspace, "external.md"), join(workspace, ".agents/skills/external.md"))
    await prepareMissionSkills(workspace, outside)
    expect(await discoverMissionSkills(outside)).toHaveLength(1)
    for (const name of [
      ".env",
      ".env.local",
      "credentials.json",
      "auth.json",
      "settings.yaml",
      "av.yaml",
      "secret.key",
      "oma-config.local.yaml",
      "state",
      "results",
      "node_modules",
      "external.md",
    ])
      await expect(readFile(join(outside, ".agents/skills", name))).rejects.toThrow()
  })

  it("does nothing without an installed harness and rejects a target directory escaping its worktree", async () => {
    await prepareMissionSkills(workspace, outside)
    await expect(readFile(join(outside, ".agents/skills"))).rejects.toThrow()
    await install("oma-safe")
    await symlink(join(workspace, ".agents"), join(outside, ".agents"))
    await expect(prepareMissionSkills(workspace, outside)).rejects.toThrow("escapes the mission worktree")
  })

  it("bounds resource copying before reading an oversized file into memory", async () => {
    await install("oma-safe")
    const large = join(workspace, ".agents/skills/large-resource.bin")
    await writeFile(large, "")
    await truncate(large, 20_000_001)
    await expect(prepareMissionSkills(workspace, outside)).rejects.toThrow("exceed 20 MB")
    await expect(readFile(join(outside, ".agents/skills/large-resource.bin"))).rejects.toThrow()
  })
})
