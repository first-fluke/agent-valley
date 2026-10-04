import { readFileSync } from "node:fs"

export function readPackageVersion(metadata: URL): string {
  const parsed: unknown = JSON.parse(readFileSync(metadata, "utf8"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !parsed.version.trim()
  ) {
    throw new Error(`Missing version in ${metadata.pathname}. Restore package.json or reinstall Agent Valley.`)
  }
  return parsed.version
}

// Source: packages/core/package.json. Bundled CLI: the distribution's package.json.
export const AV_VERSION = readPackageVersion(new URL("../package.json", import.meta.url))
