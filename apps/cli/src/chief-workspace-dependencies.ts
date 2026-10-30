import { lstat, mkdir, readdir, readFile, realpath, stat, symlink } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

const caches = new Set([".cache", ".vite", ".vite-temp"])
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)

/** Reuse installed dependencies; workspace packages resolve to the new workspace, never the source checkout. */
export async function prepareMissionDependencies(repository: string, workspace: string): Promise<void> {
  const source = await realpath(repository)
  const target = await realpath(workspace)
  if (source === target) throw new Error("Dependency preparation requires a separate mission workspace.")
  const packagePath = join(source, "package.json")
  const metadata = await readFile(packagePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (metadata === null) return
  if (metadata.length > 1_000_000) throw new Error("package.json exceeds the dependency preparation limit.")
  const configuration = JSON.parse(metadata) as { workspaces?: unknown }
  const workspaces = configuration.workspaces
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && "packages" in workspaces
      ? workspaces.packages
      : []
  if (!Array.isArray(patterns) || patterns.length > 100)
    throw new Error("Set package.json workspaces to at most 100 relative package patterns.")
  const roots = new Set([source])
  let visited = 0
  async function expand(directory: string, segments: string[]): Promise<void> {
    if (++visited > 1_000) throw new Error("Workspace dependency discovery exceeds 1,000 directories.")
    if (!segments.length) {
      const path = await realpath(directory).catch(() => undefined)
      if (path && inside(source, path)) roots.add(path)
      return
    }
    const [segment, ...rest] = segments
    if (segment === "*") {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
          await expand(join(directory, entry.name), rest)
      }
    } else if (segment) await expand(join(directory, segment), rest)
  }
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.length > 1_024 ||
      pattern.startsWith("/") ||
      pattern
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.startsWith(".") ||
            part === "node_modules" ||
            (part !== "*" && /[*?\\:]/.test(part)),
        ) ||
      pattern.split("/").length > 8
    )
      throw new Error("Use bounded relative workspace patterns in package.json before unattended execution.")
    await expand(source, pattern.split("/"))
  }
  let entries = 0
  async function link(from: string, to: string): Promise<void> {
    if (++entries > 5_000) throw new Error("Installed dependencies exceed 5,000 links; prepare a smaller workspace.")
    let installed = await realpath(from)
    if (!inside(source, installed))
      throw new Error("An installed dependency escapes the selected repository. Prepare repository-local dependencies.")
    if (!relative(source, installed).split(sep).includes("node_modules")) {
      installed = resolve(target, relative(source, installed))
      const destination = await realpath(installed).catch(() => undefined)
      if (!destination || !inside(target, destination))
        throw new Error("A workspace dependency is missing or escapes the mission workspace. Restore that package.")
      installed = destination
    }
    const existing = await lstat(to).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing) {
      if (!existing.isSymbolicLink() || (await realpath(to)) !== installed)
        throw new Error(
          "An existing mission dependency differs from the installed package. Preserve it and repair setup.",
        )
      return
    }
    await symlink(installed, to, (await stat(installed)).isDirectory() ? "dir" : "file")
  }
  for (const root of roots) {
    const modules = join(root, "node_modules")
    const installed = await stat(modules).catch(() => undefined)
    if (!installed?.isDirectory()) continue
    const destinationRoot = await realpath(resolve(target, relative(source, root)))
    if (!inside(target, destinationRoot)) throw new Error("A mission package directory escapes its workspace.")
    const destination = join(destinationRoot, "node_modules")
    const existing = await lstat(destination).catch(() => undefined)
    if (existing && !existing.isDirectory()) throw new Error("Mission node_modules must be a local directory.")
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (caches.has(entry.name)) continue
      const from = join(modules, entry.name)
      const to = join(destination, entry.name)
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        const scope = await lstat(to).catch(() => undefined)
        if (scope && !scope.isDirectory()) throw new Error("A dependency scope must be a local directory.")
        await mkdir(to, { recursive: true })
        for (const member of await readdir(from)) await link(join(from, member), join(to, member))
      } else await link(from, to)
    }
  }
}
