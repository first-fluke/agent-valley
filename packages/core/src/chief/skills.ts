import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { parseDocument } from "yaml"

export interface SkillDescriptor {
  name: string
  description: string
  /** Canonical path to an installed SKILL.md in this mission's worktree. */
  path: string
}

const MAX_SKILL_BYTES = 256_000
const MAX_METADATA_BYTES = 16_384
const MAX_CATALOG_SIZE = 100
const MAX_HARNESS_BYTES = 20_000_000
const MAX_HARNESS_ENTRIES = 5_000
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const OMA_SKILL_NAME = /^oma-[a-z0-9][a-z0-9-]{0,123}$/

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function excludedResource(name: string): boolean {
  return (
    [
      ".git",
      "node_modules",
      "__pycache__",
      ".cache",
      ".DS_Store",
      "state",
      "results",
      "auth.json",
      "settings.yaml",
      "av.yaml",
    ].includes(name) || /^(?:\.env(?:\..*)?|credentials(?:\..*)?|.*\.local\.(?:yaml|cue)|.*\.(?:pem|key))$/i.test(name)
  )
}

/** Make uncommitted installed harness resources available in a new worktree, without editing the source. */
export async function prepareMissionSkills(sourceRepositoryPath: string, workspacePath: string): Promise<void> {
  const source = await skillRoot(sourceRepositoryPath).catch(() => undefined)
  if (!source) return
  const workspace = await realpath(workspacePath)
  const agents = join(workspace, ".agents")
  await mkdir(agents, { recursive: true })
  if (!inside(workspace, await realpath(agents)))
    throw new Error(
      "The target .agents directory escapes the mission worktree. Fix its symlink before creating this order.",
    )
  const target = join(agents, "skills")
  await mkdir(target, { recursive: true })
  const targetRoot = await skillRoot(workspace)
  if (!targetRoot) throw new Error("Cannot prepare .agents/skills in the mission worktree. Restore that directory.")
  if (source === targetRoot) return
  const sourceRoot = source
  const destinationRoot = targetRoot
  let bytes = 0
  let entries = 0
  const seen = new Set<string>()
  async function copyMissing(sourceDirectory: string, targetDirectory: string): Promise<void> {
    if (seen.has(sourceDirectory)) return
    seen.add(sourceDirectory)
    for (const name of (await readdir(sourceDirectory)).sort()) {
      if (excludedResource(name)) continue
      if (++entries > MAX_HARNESS_ENTRIES)
        throw new Error(
          "The installed skill resources exceed 5,000 entries. Remove unused resources before creating this order.",
        )
      const from = await realpath(join(sourceDirectory, name)).catch(() => undefined)
      if (!from || !inside(sourceRoot, from)) continue
      const info = await stat(from)
      const to = join(targetDirectory, name)
      const existing = await lstat(to).catch(() => undefined)
      if (info.isDirectory()) {
        if (existing && !existing.isDirectory()) continue
        await mkdir(to, { recursive: true })
        const directory = await realpath(to)
        if (!inside(destinationRoot, directory))
          throw new Error(
            "A target skill resource escapes the mission worktree. Fix its symlink before creating this order.",
          )
        await copyMissing(from, directory)
      } else if (info.isFile() && !existing) {
        const parent = await realpath(targetDirectory)
        if (parent !== destinationRoot && !inside(destinationRoot, parent))
          throw new Error(
            "A target skill resource escapes the mission worktree. Fix its symlink before creating this order.",
          )
        const file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const current = await file.stat()
          if (!current.isFile()) continue
          if (bytes + current.size > MAX_HARNESS_BYTES)
            throw new Error(
              "The installed skill resources exceed 20 MB. Remove unused resources before creating this order.",
            )
          const buffer = Buffer.alloc(current.size + 1)
          let length = 0
          while (length < buffer.length) {
            const read = await file.read(buffer, length, buffer.length - length, length)
            if (!read.bytesRead) break
            length += read.bytesRead
          }
          if (length !== current.size)
            throw new Error(
              "An installed skill resource changed during preparation. Retry the order after its update finishes.",
            )
          bytes += length
          try {
            await writeFile(to, buffer.subarray(0, length), { flag: "wx", mode: current.mode & 0o777 })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          }
        } finally {
          await file.close()
        }
      }
    }
    seen.delete(sourceDirectory)
  }
  await copyMissing(sourceRoot, destinationRoot)
}

async function skillRoot(workspacePath: string): Promise<string | undefined> {
  const workspace = await realpath(workspacePath).catch(() => undefined)
  if (!workspace) return undefined
  const root = await realpath(join(workspace, ".agents", "skills")).catch(() => undefined)
  if (!root) return undefined
  if (!inside(workspace, root))
    throw new Error("The skill directory escapes the mission worktree. Install the OMA harness inside this repository.")
  if (!(await stat(root)).isDirectory()) return undefined
  return root
}

async function skillPath(root: string, name: string): Promise<string> {
  if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name: ${name}. Select an installed skill directory name.`)
  const path = await realpath(join(root, name, "SKILL.md")).catch(() => {
    throw new Error(`Skill ${name}/SKILL.md is missing. Restore that installed skill in ${root} before resuming.`)
  })
  if (!inside(root, path)) throw new Error(`Skill ${name} escapes the skill directory. Fix its symlink before running.`)
  return path
}

/** Read from a verified file handle; never follow a replacement leaf symlink or read an unbounded file. */
async function readSkill(path: string, metadataOnly: boolean): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error("SKILL.md must be a regular file. Restore the installed skill.")
    if (info.size > MAX_SKILL_BYTES)
      throw new Error("Skill instructions exceed 256 KB. Select a smaller installed skill before resuming.")
    const limit = metadataOnly ? MAX_METADATA_BYTES + 1 : MAX_SKILL_BYTES + 1
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    if (!metadataOnly && bytesRead > MAX_SKILL_BYTES)
      throw new Error("Skill instructions exceed 256 KB. Select a smaller installed skill before resuming.")
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await file.close()
  }
}

function metadata(source: string, name: string, path: string): SkillDescriptor | undefined {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match?.[1] || Buffer.byteLength(match[0]) > MAX_METADATA_BYTES) return undefined
  try {
    const document = parseDocument(match[1], { strict: true, uniqueKeys: true, prettyErrors: false })
    if (document.errors.length || document.warnings.length) return undefined
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const fields = value as Record<string, unknown>
    if (fields.name !== name || typeof fields.description !== "string") return undefined
    const description = fields.description.trim().replace(/\s+/gu, " ")
    if (
      !description ||
      description.length > 1_000 ||
      [...description].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return undefined
    return { name, description, path }
  } catch {
    return undefined
  }
}

async function descriptor(root: string, name: string): Promise<SkillDescriptor | undefined> {
  if (!OMA_SKILL_NAME.test(name)) return undefined
  const directory = await realpath(join(root, name))
  if (!inside(root, directory) || !(await stat(directory)).isDirectory()) return undefined
  const path = await skillPath(root, name)
  return metadata(await readSkill(path, true), name, path)
}

/** Discover installed OMA metadata only. Broken, unreadable, or malformed entries are omitted. */
export async function discoverMissionSkills(workspacePath: string): Promise<SkillDescriptor[]> {
  const root = await skillRoot(workspacePath).catch(() => undefined)
  if (!root) return []
  const entries = await readdir(root).catch(() => [])
  const catalog: SkillDescriptor[] = []
  for (const name of entries.sort()) {
    const skill = await descriptor(root, name).catch(() => undefined)
    if (skill) catalog.push(skill)
    if (catalog.length > MAX_CATALOG_SIZE)
      throw new Error("The worktree has more than 100 OMA skills. Remove unused skills before creating this order.")
  }
  return catalog
}

/** Revalidate every persisted descriptor, including unselected paths, before showing it to an agent. */
export async function validateMissionSkills(workspacePath: string, catalog: readonly SkillDescriptor[]): Promise<void> {
  if (!catalog.length) return
  if (catalog.length > MAX_CATALOG_SIZE)
    throw new Error("The saved skill catalog exceeds 100 entries. Restore its mission record.")
  const root = await skillRoot(workspacePath)
  if (!root)
    throw new Error("The saved skill catalog requires .agents/skills. Install its OMA harness before resuming.")
  const names = new Set<string>()
  for (const saved of catalog) {
    if (names.has(saved.name)) throw new Error("The saved skill catalog repeats a name. Restore its mission record.")
    names.add(saved.name)
    const current = await descriptor(root, saved.name).catch(() => undefined)
    if (!current || current.path !== saved.path || current.description !== saved.description)
      throw new Error(
        `Saved skill ${saved.name} no longer matches this worktree. Restore its installed metadata and path before resuming.`,
      )
  }
}

/** Legacy explicit personas may omit catalog; automatic personas can load only catalog-selected bodies. */
export async function loadMissionSkillBodies(
  workspacePath: string,
  selectedNames: readonly string[],
  catalog?: readonly SkillDescriptor[],
): Promise<string> {
  if (catalog) await validateMissionSkills(workspacePath, catalog)
  if (!selectedNames.length) return ""
  const root = await skillRoot(workspacePath)
  if (!root)
    throw new Error(
      "Selected Actor skills require .agents/skills in the target repository. Install its OMA harness or remove skills from the Actor profile.",
    )
  const sections: string[] = []
  let bytes = 0
  for (const name of [...new Set(selectedNames)]) {
    if (!SKILL_NAME.test(name))
      throw new Error(`Invalid skill name: ${name}. Select an installed skill directory name.`)
    if (catalog && !catalog.some((skill) => skill.name === name))
      throw new Error(`Skill ${name} is absent from the verified mission catalog. Select an availableSkills name.`)
    const path = await skillPath(root, name)
    const content = await readSkill(path, false)
    bytes += Buffer.byteLength(content)
    if (bytes > MAX_SKILL_BYTES)
      throw new Error("The Actor has more than 256 KB of skill instructions. Select fewer skills.")
    sections.push(`## Skill ${name}\nSource: ${path}\n${content}`)
  }
  return sections.join("\n\n")
}
