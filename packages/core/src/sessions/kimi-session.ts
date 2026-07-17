/**
 * KimiSession — Kimi Code CLI with streaming NDJSON output.
 *
 * Mode: kimi -p "<prompt>" --output-format stream-json
 * Input: prompt passed as the -p/--prompt argument value (Node spawn uses
 *   an argv array, not a shell, so this carries no shell-injection risk —
 *   kimi has no documented stdin-prompt mode, so argv is used here, same
 *   rationale as grok-session.ts / cursor-session.ts).
 * Output: NDJSON lines — one JSON event per line (schema unverified, see below).
 *
 * // verified against kimi --help (Kimi Code, installed at ~/.kimi-code/bin/kimi)
 * // cross-checked against the official docs (moonshotai.github.io/kimi-code llms-full.txt)
 * Confirmed flags:
 *   -p, --prompt "<prompt>"     run one prompt non-interactively, print the response
 *   --output-format text|stream-json   USE stream-json for NDJSON streaming
 *   --skills-dir <dir>          load skills from this dir — see note below on why
 *     this adapter deliberately does NOT pass it
 *   -m, --model <model>         model alias (defaults to config.toml default_model)
 *   -S/--session [id], -C/--continue   session continuity (not used — one-shot per execute())
 *   acp subcommand               ACP server over stdio — NOT used here; this
 *     adapter uses one-shot `-p`, like claude/gemini's fallback mode.
 *
 * CRITICAL CONSTRAINT (discovered by real invocation against the actual
 * kimi binary): kimi FORBIDS combining -p/--prompt with --yolo OR --auto
 * ("error: Cannot combine --prompt with --yolo/--auto"). DO NOT add any
 * auto-approve flag to prompt-mode argv below — `-p` already runs
 * non-interactively on its own. Containment comes from the OS sandbox
 * (planSandboxedSpawn), the same as every other session — NOT from an
 * agent-CLI auto-approve flag. If a permission prompt hang is ever
 * observed, do not "fix" it by adding --yolo/--auto here: kimi will
 * refuse to start with the error above.
 *
 * --skills-dir is INTENTIONALLY NOT PASSED. Per the official docs, kimi
 * auto-discovers project skill dirs in priority order Project > User >
 * Extra > Built-in, and the auto-discovered project dirs already include
 * BOTH `.kimi-code/skills/` AND `.agents/skills/` — so the oma harness
 * loads without any flag when the target repo has `.agents/skills/`
 * (absent -> kimi just runs without oma skills, same graceful behavior as
 * every other vendor). Passing `--skills-dir <dir>` REPLACES the
 * auto-discovered user AND project directories for that session (per the
 * docs), which would silently drop `.kimi-code/skills/` and user-level
 * skills — a strictly worse outcome than doing nothing. Do not add this
 * flag back without re-reading that replace-not-append semantics first.
 *
 * NDJSON event schema: UNVERIFIED AGAINST A REAL AUTHENTICATED RUN. The
 * machine used to write this adapter had kimi unauthenticated ("No model
 * configured"), so no real success-path NDJSON could be captured. The
 * parser below is a TOLERANT parser mirroring cursor-session.ts /
 * grok-session.ts's defensive approach for exactly this situation:
 *   - Primary path: claude-style events — {"type":"assistant","message":
 *     {"content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}},
 *     {"type":"result","is_error":bool,"result":"...","usage":
 *     {"input_tokens":N,"output_tokens":N,...}}, {"type":"system",...}.
 *   - Fallback path: flatter shapes — text/content/delta fields directly
 *     on the event, and a top-level tool_use/tool_call event, for schema
 *     drift or a different underlying protocol.
 * Verify this against a real authenticated `kimi -p ... --output-format
 * stream-json` run and update this doc comment once confirmed.
 *
 * Auth failure: kimi prints "No model configured" (observed directly,
 * unauthenticated) and exits non-zero when `kimi /login` hasn't been run.
 * This text is not guaranteed to be valid NDJSON, so it's detected from
 * the combined raw stdout+stderr tail rather than the JSON parser, and
 * surfaced as an AUTH_FAILED error naming the fix.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv, waitForStreamCompletion } from "./base-session"
import { planSandboxedSpawn } from "./sandbox"

export const KIMI_COMMAND = "kimi"

/** Bytes of raw stdout+stderr tail retained for unauth/failure-message detection. */
const MAX_RAW_TAIL_BYTES = 4 * 1024

export class KimiSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  /** Bounded tail of raw stdout+stderr bytes, used only to detect the plain-text "No model configured" unauth message. */
  private rawTail = ""

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    this.filesChanged = []
    this.rawTail = ""
    this.startedAt = Date.now()

    const args = ["-p", prompt, "--output-format", "stream-json"]

    // No --skills-dir here — see module doc comment: kimi already
    // auto-discovers `.agents/skills/` as a project skill dir, and passing
    // --skills-dir would REPLACE (not add to) that auto-discovery.

    if (this.config.model) {
      args.push("--model", this.config.model)
    }

    // NO --yolo/--auto here — see module doc comment: kimi refuses to
    // start with "Cannot combine --prompt with --yolo/--auto". Containment
    // for non-interactive -p mode comes from the OS sandbox wrapping this
    // spawn. planSandboxedSpawn() fails closed (throws) when no sandbox is
    // available unless SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: "kimi",
        command: KIMI_COMMAND,
        args,
        workspacePath: this.config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    this.process = spawn(plan.command, plan.args, {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("kimi", this.config.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    await this.readStream()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return this.process.exitCode === null
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) return

    const decoder = new TextDecoder()
    let buffer = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true })
      this.appendRawTail(text)
      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event: unknown = JSON.parse(line)
          this.handleEvent(event)
        } catch {
          // Non-JSON stdout noise (e.g. a plain-text auth error) — still
          // captured in rawTail for the unauth-detection check below.
        }
      }
    })

    proc.stdout.on("error", () => {
      // Stream error — proceed to close
    })

    const stderrDecoder = new TextDecoder()
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.appendRawTail(stderrDecoder.decode(chunk, { stream: true }))
    })

    // Gated on BOTH stdout 'end' and process 'close' — see
    // waitForStreamCompletion() doc comment (base-session.ts) for why
    // 'close' alone races the final buffered 'data' chunk on a
    // fast-exiting process.
    const { exitCode: code } = await waitForStreamCompletion(proc)
    const exitCode = code ?? -1

    if (exitCode !== 0) {
      if (/no model configured/i.test(this.rawTail)) {
        this.emitError(
          "AUTH_FAILED",
          'kimi is not authenticated ("No model configured").\n' +
            "  Fix: run `kimi` then `/login` (device-code auth) to set a default_model in ~/.kimi-code/config.toml.\n" +
            "  This must be done once per host before Symphony can run kimi non-interactively.",
          false,
        )
        return
      }
      this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `kimi exited with code ${exitCode}`, exitCode !== 1)
    }
  }

  private appendRawTail(chunk: string): void {
    this.rawTail += chunk
    if (this.rawTail.length > MAX_RAW_TAIL_BYTES) {
      this.rawTail = this.rawTail.slice(-MAX_RAW_TAIL_BYTES)
    }
  }

  /**
   * Tolerant parser — schema UNVERIFIED against a real authenticated run
   * (see module doc comment). Primary path mirrors claude-lineage CLIs
   * (assistant/result/system events, message.content[] blocks, is_error,
   * usage.input_tokens/output_tokens). Fallback path handles flatter
   * text/content/delta shapes and a top-level tool_use/tool_call event
   * for schema drift or a different underlying protocol.
   */
  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>

    switch (e.type) {
      case "assistant":
        this.handleAssistantEvent(e)
        break

      case "result":
        this.handleResultEvent(e)
        break

      case "system":
      case "user":
      case "thinking":
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        break

      case "tool_use":
      case "tool_call":
        this.handleToolCallEvent(e)
        break
    }
  }

  private handleAssistantEvent(e: Record<string, unknown>): void {
    // Primary path: claude-shaped nested message.content blocks.
    const msg = e.message as Record<string, unknown> | undefined
    const content = msg?.content as Array<Record<string, unknown>> | undefined
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          // Stream-only — no accumulation, prevents OOM
          this.emit({ type: "output", chunk: block.text })
        }
        if (block.type === "tool_use") {
          const toolName = (block.name as string | undefined) ?? "unknown"
          const input = (block.input as Record<string, unknown> | undefined) ?? {}
          this.emitToolUse(toolName, input)
        }
      }
      return
    }

    // Flatter shape fallback: text/content/delta directly on the event.
    const text = e.text ?? e.content ?? e.delta
    if (typeof text === "string" && text.length > 0) {
      this.emit({ type: "output", chunk: text })
    }
  }

  private handleToolCallEvent(e: Record<string, unknown>): void {
    const toolName = (e.name as string | undefined) ?? (e.tool as string | undefined) ?? "unknown"
    const args =
      (e.input as Record<string, unknown> | undefined) ?? (e.args as Record<string, unknown> | undefined) ?? {}
    this.emitToolUse(toolName, args)
  }

  private emitToolUse(toolName: string, args: Record<string, unknown>): void {
    this.emit({ type: "toolUse", tool: toolName, args })

    if (/^(edit|write|create)$/i.test(toolName)) {
      const path =
        (args.file_path as string | undefined) ??
        (args.path as string | undefined) ??
        (args.filePath as string | undefined)
      if (path && !this.filesChanged.includes(path)) {
        this.filesChanged.push(path)
        this.emit({
          type: "fileChange",
          path,
          changeType: /^write|create$/i.test(toolName) ? "add" : "modify",
        })
      }
    }
  }

  private handleResultEvent(e: Record<string, unknown>): void {
    const result = (e.result as string | undefined) ?? (e.text as string | undefined) ?? ""
    const durationMs = (e.duration_ms as number | undefined) ?? (e.durationMs as number | undefined) ?? this.elapsedMs()
    const isError = e.is_error === true || e.isError === true

    if (isError) {
      this.emitError("CRASH", result || "kimi reported an error result", true)
      return
    }

    this.emit({
      type: "complete",
      result: {
        exitCode: 0,
        output: result.length > 10240 ? result.slice(-10240) : result,
        durationMs,
        filesChanged: this.filesChanged,
        tokenUsage: this.extractTokenUsage(e),
      },
    })
  }

  private extractTokenUsage(
    resultEvent: Record<string, unknown>,
  ): { input: number; output: number; model: string } | undefined {
    const usage = resultEvent.usage as Record<string, unknown> | undefined
    if (!usage) return undefined

    const input = (usage.input_tokens as number | undefined) ?? (usage.inputTokens as number | undefined) ?? 0
    const output = (usage.output_tokens as number | undefined) ?? (usage.outputTokens as number | undefined) ?? 0
    const cacheRead =
      (usage.cache_read_input_tokens as number | undefined) ?? (usage.cacheReadTokens as number | undefined) ?? 0
    const cacheCreation =
      (usage.cache_creation_input_tokens as number | undefined) ??
      (usage.cacheCreationTokens as number | undefined) ??
      0

    if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return undefined

    const model =
      (resultEvent.model as string | undefined) ?? (usage.model as string | undefined) ?? this.config?.model ?? "kimi"

    return {
      input: input + cacheRead + cacheCreation,
      output,
      model,
    }
  }
}
