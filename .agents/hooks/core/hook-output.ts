// Vendor-specific hook output builders.
// Each runtime (Claude Code, Codex CLI, Cursor, Qwen Code)
// expects a slightly different stdout JSON shape; centralize the dialect
// translation here so individual hooks can stay vendor-agnostic.

import type { Vendor } from "./types.ts"

export function makePromptOutput(
  vendor: Vendor,
  additionalContext: string,
  // Native hook event the context is injected for. Defaults to the prompt-submit
  // event; the dispatch layer passes "SessionStart" for session-start injection
  // (commandcode / cursor sessionStart) so the emitted hookSpecificOutput names
  // the correct event. Standalone core-script callers use the default.
  hookEventName: string = "UserPromptSubmit",
): string {
  switch (vendor) {
    case "antigravity":
      // agy (Antigravity) does NOT read `additionalContext`. Per the official
      // contract (antigravity.google/docs/hooks), a PreInvocation hook injects
      // context by returning `injectSteps`, where `ephemeralMessage` is a
      // transient system-message step prepended before the model is called.
      return JSON.stringify({
        injectSteps: [{ ephemeralMessage: additionalContext }],
      })
    case "claude":
    case "commandcode": {
      // Official Claude Code docs (code.claude.com/docs/en/hooks) specify
      // `hookSpecificOutput.additionalContext` — the top-level field is kept
      // for back-compat with older builds that read it.
      // commandcode (Command Code, commandcode.ai) mirrors the Claude hook
      // dialect. It has no prompt-submit event, but DOES inject context on
      // SessionStart (additionalContext) — dispatch passes hookEventName
      // "SessionStart" for that path.
      const hookSpecificOutput: Record<string, unknown> = {
        hookEventName,
        additionalContext,
      }
      // Claude Code re-scans skill/command directories after SessionStart hooks
      // complete when the output sets `reloadSkills` (docs: SessionStart
      // hookSpecificOutput.reloadSkills). It is Claude-only and only meaningful
      // for SessionStart; this builder is called solely when context was
      // actually injected, so the "only when injecting" condition is inherent.
      if (vendor === "claude" && hookEventName === "SessionStart") {
        hookSpecificOutput.reloadSkills = true
      }
      return JSON.stringify({ additionalContext, hookSpecificOutput })
    }
    case "codex":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      })
    case "cursor":
      // Cursor reads the top-level `additional_context` (sessionStart) /
      // `additionalContext`; the hookSpecificOutput block is informational.
      return JSON.stringify({
        additionalContext,
        additional_context: additionalContext,
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      })
    case "grok":
      // Grok hook context injection: return additionalContext; Grok may surface
      // it via hook annotations or ignore for prompt events. State side-effects
      // (mode activation, L1 events) are the primary mechanism.
      return JSON.stringify({ additionalContext })
    case "kiro":
      // Kiro CLI adds stdout directly to the agent context for prompt hooks.
      return additionalContext
    case "kimi":
      // Kimi Code CLI: a blockable hook that exits 0 has its stdout appended to
      // the model context (kimi.com/code/docs hooks). Plain text injects directly.
      return additionalContext
    case "pi":
      // pi (Earendil) reads this via the in-process bridge in
      // `.pi/extensions/oma/index.ts`, which lifts `additionalContext` into the
      // `before_agent_start` return as `{ systemPrompt: <prev> + context }`.
      return JSON.stringify({ additionalContext })
    case "qwen":
      // Qwen Code fork uses hookSpecificOutput (same as Codex)
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      })
  }
}

export function makeBlockOutput(vendor: Vendor, reason: string): string {
  switch (vendor) {
    case "claude":
    case "codex":
    case "commandcode":
    case "kiro":
    case "qwen":
      return JSON.stringify({ decision: "block", reason })
    case "cursor":
      // Cursor's `stop` hook ignores Claude-style `{decision:"block"}`. It
      // re-enters the loop via `{followup_message}`, which is auto-submitted as
      // the next turn (capped by the entry's loop_limit). Cursor's only
      // block-producing chain is `stop` — its sole preToolUse handler
      // (test-filter) never blocks, only mutates — so followup_message is
      // always the correct dialect here.
      return JSON.stringify({ followup_message: reason })
    case "antigravity":
      // agy Stop: `decision:"continue"` re-enters the loop (= block the stop);
      // `reason` is injected as a system message. (Any other value allows stop.)
      return JSON.stringify({ decision: "continue", reason })
    case "pi":
      // pi's bridge implements persistent-mode via agent_settled +
      // pi.sendUserMessage: it runs the persistent-mode subprocess (which
      // resolves to the Claude dialect `{decision:"block", reason}`) and also
      // accepts this `{block:true, reason}` shape, re-submitting `reason` as the
      // next turn so the workflow continues.
      return JSON.stringify({ block: true, reason })
    case "grok":
      // Grok Stop hooks are generally advisory. Emit block decision + rich
      // stderr message (persistent-mode already prints the reason to stderr).
      return JSON.stringify({ decision: "block", reason })
    case "kimi":
      // Kimi documents two blocking mechanisms: exit 2 + stderr, and a JSON
      // `hookSpecificOutput.permissionDecision: "deny"` response. The oma hook
      // router always exits 0 and writes the dialect to stdout, so we emit the
      // JSON form. We also include the Claude-style `{decision:"block"}` keys so
      // whichever shape Kimi's Stop handler honours, persistent-mode re-enters.
      return JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })
  }
}

export function makePreToolOutput(vendor: Vendor, updatedInput: Record<string, unknown>): string {
  switch (vendor) {
    case "cursor":
      return JSON.stringify({
        updated_input: updatedInput,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput,
        },
      })
    case "claude":
    case "codex":
    case "commandcode":
    case "kimi":
    case "kiro":
    case "qwen":
      // Codex requires `permissionDecision: "allow"` alongside `updatedInput`
      // ("other updatedInput shapes are reported as errors" —
      // developers.openai.com/codex/hooks); Claude documents the same shape.
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      })
    case "pi":
      // pi's bridge reads `updatedInput.command` and mutates the live
      // `tool_call` event input in place (pi exposes event.input as mutable).
      return JSON.stringify({ updatedInput })
    case "antigravity":
      // agy PreToolUse output is a gate decision; it cannot rewrite tool input.
      // Allow execution (test-filter is advisory on agy). updatedInput unused.
      void updatedInput
      return JSON.stringify({ decision: "allow" })
    case "grok":
      // Grok PreToolUse uses decision + possibly updated tool input
      return JSON.stringify({
        decision: "allow",
        toolInput: updatedInput,
      })
  }
}
