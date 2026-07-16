/**
 * sandbox-types.ts — Shared types for the OS-level sandbox wrapper.
 *
 * Kept in its own file so sandbox-darwin.ts and sandbox-linux.ts do not
 * need to import from sandbox.ts (would create a circular dependency,
 * since sandbox.ts imports the platform builders).
 */

export interface SandboxBuildRequest {
  /** Agent type, used only for log/error messages ("claude" | "codex" | "gemini" | custom). */
  agentType: string
  /** Base binary to execute inside the sandbox, e.g. "claude". */
  command: string
  /** Base argv for `command` (already includes the CLI's own non-interactive flags). */
  args: string[]
  /** Git worktree path the agent is allowed to write to. */
  workspacePath: string
  /** Resolved domain allowlist for outbound network egress. */
  networkAllowlist: string[]
}

export interface SandboxCommand {
  /** The wrapper binary to spawn instead of `req.command` directly. */
  command: string
  /** Full argv for the wrapper binary, including `req.command`/`req.args` at the tail. */
  args: string[]
}
