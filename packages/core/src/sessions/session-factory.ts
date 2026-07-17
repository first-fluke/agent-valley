/**
 * SessionFactory — Registry-based factory for creating AgentSession instances.
 *
 * Built-in sessions: codex, claude, antigravity, cursor, grok, kimi, opencode.
 * Community/custom sessions can be registered at runtime.
 */

import type { AgentSession } from "./agent-session"

type SessionConstructor = () => AgentSession

/**
 * SessionRegistry — encapsulates the mutable registry map.
 * Avoids module-level shared mutable state (CONSTRAINTS.md rule 6).
 */
export class SessionRegistry {
  private registry = new Map<string, SessionConstructor>()

  /**
   * Register a session implementation for an agent type.
   * Overwrites any existing registration for the same type.
   */
  register(agentType: string, factory: SessionConstructor): void {
    this.registry.set(agentType, factory)
  }

  /**
   * Create a new AgentSession instance for the given agent type.
   * Throws if the type is not registered.
   */
  create(agentType: string): AgentSession {
    const factory = this.registry.get(agentType)
    if (!factory) {
      const available = Array.from(this.registry.keys()).join(", ") || "(none)"
      throw new Error(
        `Unknown agent type: "${agentType}". ` +
          `Available: ${available}. ` +
          `Register custom agents via registerSession("${agentType}", () => new YourSession())`,
      )
    }
    return factory()
  }

  /**
   * List all registered agent types.
   */
  list(): string[] {
    return Array.from(this.registry.keys())
  }

  /**
   * Register built-in sessions. Called once at startup.
   * Lazy imports to avoid loading unused session implementations.
   */
  async registerBuiltins(): Promise<void> {
    const { CodexSession } = await import("./codex-session")
    const { ClaudeSession } = await import("./claude-session")
    const { AgySession } = await import("./agy-session")
    const { CursorSession } = await import("./cursor-session")
    const { GrokSession } = await import("./grok-session")
    const { KimiSession } = await import("./kimi-session")
    const { OpencodeSession } = await import("./opencode-session")

    this.register("codex", () => new CodexSession())
    this.register("claude", () => new ClaudeSession())
    this.register("antigravity", () => new AgySession())
    this.register("cursor", () => new CursorSession())
    this.register("grok", () => new GrokSession())
    this.register("kimi", () => new KimiSession())
    this.register("opencode", () => new OpencodeSession())
  }
}

/** Default registry instance — backward compatible with prior module-level API */
export const defaultRegistry = new SessionRegistry()

// ── Backward-compatible function exports ─────────────────────────────────────

export function registerSession(agentType: string, factory: SessionConstructor): void {
  defaultRegistry.register(agentType, factory)
}

export function createSession(agentType: string): AgentSession {
  return defaultRegistry.create(agentType)
}

export function listSessionTypes(): string[] {
  return defaultRegistry.list()
}

export async function registerBuiltinSessions(): Promise<void> {
  return defaultRegistry.registerBuiltins()
}
