import { nativeProfilePath } from "./native-profile"

/** QWEN_HOME names Qwen Code's user profile, not an API credential. Relative profiles vary per worktree. */
export function qwenProfilePath(home: string, env: Readonly<Record<string, string | undefined>>): string | null {
  return nativeProfilePath(home, env, "QWEN_HOME", ".qwen")
}
