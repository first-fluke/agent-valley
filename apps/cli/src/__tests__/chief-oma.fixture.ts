import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function installOmaFixture(repository: string): Promise<string> {
  const path = join(repository, ".agents/skills/oma-fixture-helper")
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, "SKILL.md"),
    "---\nname: oma-fixture-helper\ndescription: Write a checked file deliverable\n---\n\nFixture helper instructions: inspect the actual file before reporting completion.\n",
  )
  await mkdir(join(repository, ".agents/agents"), { recursive: true })
  await writeFile(
    join(repository, ".agents/agents/file-writer.md"),
    "---\nname: file-writer\nskills: [oma-fixture-helper]\n---\nInstalled OMA file writer: inspect the assigned deliverable.",
  )
  return path
}
