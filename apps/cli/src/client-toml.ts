import { parse } from "smol-toml"

/** Parse native client configuration in both source/Bun and distributed/Node runtimes. */
export function parseClientToml(source: string): unknown {
  return parse(source, { integersAsBigInt: "asNeeded" })
}
