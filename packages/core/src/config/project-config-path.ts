import { resolve } from "node:path"

export const PROJECT_CONFIG_FILENAME = "av.yaml"

/** Project configuration is read and written only at av.yaml. */
export function resolveProjectConfigPath(root: string): string {
  return resolve(root, PROJECT_CONFIG_FILENAME)
}
