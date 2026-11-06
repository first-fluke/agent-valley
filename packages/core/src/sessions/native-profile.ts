import { isAbsolute, join, relative, resolve, sep } from "node:path"

/** Resolve native CLI data directories consistently across discovery and isolated worktrees. */
export function nativeProfilePath(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  defaultDirectory: string,
  childDirectory = "",
): string | null {
  const configured = env[key]
  if (!configured) return join(home, defaultDirectory)
  const base =
    configured === "~"
      ? resolve(home)
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? resolve(home, configured.slice(2))
        : isAbsolute(configured)
          ? resolve(configured)
          : null
  if (base === null) return null
  const candidate = resolve(base, childDirectory)
  // These directories become sandbox write grants. A root/home/ancestor is not a profile.
  const toHome = relative(candidate, resolve(home))
  const ancestor = toHome === "" || (toHome !== ".." && !toHome.startsWith(`..${sep}`) && !isAbsolute(toHome))
  return ancestor ? null : candidate
}
