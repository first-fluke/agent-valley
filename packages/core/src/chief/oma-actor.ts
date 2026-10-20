import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { parseDocument } from "yaml"
import { discoverMissionSkills, loadMissionSkillBodies } from "./skills"

export interface PreparedOmaActor {
  agentId: string
  guidance: string
  skills: string[]
  digest: string
}

/** Receipt enforcement is optional; an installed OMA catalog always requires OMA execution inputs. */
export function requiresOmaActor(mission: { oma?: boolean; availableSkills?: readonly unknown[] }): boolean {
  return Boolean(mission.oma || mission.availableSkills?.length)
}

interface InstalledProfile {
  agentId: string
  path: string
  source: string
  skills: string[]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const MAX_PROFILE_BYTES = 64_000
const MAX_METADATA_BYTES = 16_384
const MAX_SCAN_BYTES = 1_000_000
const MAX_GUIDANCE_BYTES = 256_000
const MAX_PROFILES = 100

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function invalidProfile(path: string): Error {
  return new Error(
    `OMA agent profile ${path} is invalid. Restore YAML frontmatter with name matching its filename and a nonempty skills list of installed skill names.`,
  )
}

function profileSkills(source: string, agentId: string, path: string): string[] {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match?.[1] || Buffer.byteLength(match[0]) > MAX_METADATA_BYTES) throw invalidProfile(path)
  try {
    const document = parseDocument(match[1], { strict: true, uniqueKeys: true, prettyErrors: false })
    if (document.errors.length || document.warnings.length) throw invalidProfile(path)
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProfile(path)
    const fields = value as Record<string, unknown>
    if (
      fields.name !== agentId ||
      !Array.isArray(fields.skills) ||
      !fields.skills.length ||
      fields.skills.length > 100 ||
      !fields.skills.every((name): name is string => typeof name === "string" && NAME.test(name)) ||
      new Set(fields.skills).size !== fields.skills.length ||
      !source.slice(match[0].length).trim()
    )
      throw invalidProfile(path)
    return fields.skills
  } catch {
    throw invalidProfile(path)
  }
}

async function readProfile(root: string, filename: string): Promise<InstalledProfile> {
  const agentId = filename.slice(0, -3)
  const requested = join(root, filename)
  if (!NAME.test(agentId)) throw invalidProfile(requested)
  const path = await realpath(requested).catch(() => {
    throw new Error(`OMA agent profile ${requested} is unreadable. Restore the installed profile before resuming.`)
  })
  if (!inside(root, path))
    throw new Error(`OMA agent profile ${requested} escapes .agents/agents. Fix its symlink before resuming.`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error(`OMA agent profile ${requested} is unreadable. Restore its file permissions before resuming.`)
  })
  try {
    const info = await file.stat()
    if (!info.isFile())
      throw new Error(`OMA agent profile ${requested} must be a regular file. Restore its definition.`)
    if (info.size > MAX_PROFILE_BYTES)
      throw new Error(`OMA agent profile ${requested} exceeds 64 KB. Reduce its instructions before resuming.`)
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length !== info.size)
      throw new Error(`OMA agent profile ${requested} changed while reading. Retry after its update finishes.`)
    const source = buffer.subarray(0, length).toString("utf8")
    return { agentId, path, source, skills: profileSkills(source, agentId, requested) }
  } finally {
    await file.close()
  }
}

/** Bind an installed OMA definition and its complete skills to the existing native Actor runner. */
export async function prepareOmaActor(
  workspacePath: string,
  selectedSkills: readonly string[],
): Promise<PreparedOmaActor> {
  if (!selectedSkills.length)
    throw new Error("OMA work requires an assigned skill. Select an installed skill associated with .agents/agents.")
  for (const name of selectedSkills)
    if (!NAME.test(name)) throw new Error(`Invalid skill name: ${name}. Select an installed skill directory name.`)
  const selected = [...new Set(selectedSkills)].sort()
  const workspace = await realpath(workspacePath)
  const directory = join(workspace, ".agents", "agents")
  const root = await realpath(directory).catch(() => {
    throw new Error(
      `OMA work requires installed agent profiles in ${directory}. Install the OMA harness before resuming.`,
    )
  })
  if (!inside(workspace, root))
    throw new Error(
      "The OMA agent directory escapes the mission worktree. Install .agents/agents inside this repository.",
    )
  if (!(await stat(root)).isDirectory())
    throw new Error(`OMA agent profiles require a directory at ${directory}. Restore the installed OMA harness.`)
  const filenames = (await readdir(root)).filter((name) => name.endsWith(".md")).sort()
  if (filenames.length > MAX_PROFILES)
    throw new Error("The worktree has more than 100 OMA agent profiles. Remove unused profiles before resuming.")
  let chosen: InstalledProfile | undefined
  let overlap = 0
  let bytes = 0
  for (const filename of filenames) {
    const profile = await readProfile(root, filename)
    bytes += Buffer.byteLength(profile.source)
    if (bytes > MAX_SCAN_BYTES)
      throw new Error("Installed OMA agent profiles exceed 1 MB. Reduce unused profile instructions before resuming.")
    if (selected.some((name) => !name.startsWith("oma-") && !profile.skills.includes(name))) continue
    const score = selected.filter((name) => profile.skills.includes(name)).length
    if (score > overlap) {
      chosen = profile
      overlap = score
    }
  }
  if (!chosen)
    throw new Error(
      `No installed OMA agent profile matches skills ${selected.join(", ")}. Associate the assigned skills with a profile in ${directory}; custom skills must be declared by that profile.`,
    )
  const skills = [...new Set([...chosen.skills, ...selected])].sort()
  const catalog = await discoverMissionSkills(workspace)
  for (const name of skills)
    if (name.startsWith("oma-") && !catalog.some((skill) => skill.name === name))
      throw new Error(
        `OMA skill ${name} is missing or invalid. Restore .agents/skills/${name}/SKILL.md before resuming.`,
      )
  const bodies = await loadMissionSkillBodies(workspace, skills)
  const guidance = [`## Installed OMA agent ${chosen.agentId}\nSource: ${chosen.path}\n${chosen.source}`, bodies].join(
    "\n\n",
  )
  if (Buffer.byteLength(guidance) > MAX_GUIDANCE_BYTES)
    throw new Error(
      "The OMA agent and bound skill instructions exceed 256 KB. Reduce assigned instructions before resuming.",
    )
  return { agentId: chosen.agentId, guidance, skills, digest: createHash("sha256").update(guidance).digest("hex") }
}
