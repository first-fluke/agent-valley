/** Repository-local actor CLI configuration; native CLIs migrate these files mid-run without product intent. */
const actorConfigDirectories = [
  ".claude",
  ".codex",
  ".cursor",
  ".dsh",
  ".gemini",
  ".grok",
  ".kimi-code",
  ".opencode",
  ".qwen",
  ".zcode",
]

export function isActorConfigPath(name: string): boolean {
  return actorConfigDirectories.some((directory) => name === directory || name.startsWith(`${directory}/`))
}
