/**
 * CursorSession — Cursor Agent (`cursor-agent`) with streaming NDJSON output.
 *
 * Mode: cursor-agent -p --output-format stream-json --stream-partial-output --force
 * Input: prompt passed as a guarded trailing positional argv (see note below)
 * Output: NDJSON lines — system, user, assistant, thinking, tool_call, result
 *
 * Note: cursor-agent is NOT a persistent server (like Claude Code). Each
 * execute() spawns a new process. The "session" manages process lifecycle
 * and event normalization.
 *
 * Flags verified against `cursor-agent --help` v2026.07.09 (installed,
 * checked directly): -p/--print, --output-format text|json|stream-json,
 * --stream-partial-output, --force/--yolo, --api-key / CURSOR_API_KEY env,
 * --model, --resume [chatId], --continue, --mode plan|ask. `--force` is
 * REQUIRED (not optional) for non-interactive use — without it, a live run
 * hit a "Workspace Trust Required" prompt with no TTY to answer it.
 *
 * Wire format — CONFIRMED by a live `cursor-agent -p --output-format
 * stream-json --force` run (v2026.07.09):
 *   {"type":"system","subtype":"init","apiKeySource":"login","cwd":"...",
 *    "session_id":"...","model":"Fable 5 300K High","permissionMode":"default"}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
 * This confirms cursor-agent's stream-json is Claude-Code-lineage: same
 * `type` / `message.content[]` / snake_case `session_id` shape as
 * claude-session.ts. The live run hit a Cursor usage-limit error before an
 * `assistant`/`result` event was captured, so the assistant/result/usage
 * shapes below are CLAUDE-PARITY, HIGH-CONFIDENCE BUT NOT DIRECTLY
 * OBSERVED — verify against a real successful completion when quota
 * allows, then remove this caveat:
 *   {"type":"assistant","message":{"role":"assistant","content":[
 *      {"type":"text","text":"..."},
 *      {"type":"tool_use","name":"...","input":{...}}]},"session_id":"..."}
 *   {"type":"result","subtype":"success"|"error","is_error":bool,
 *    "result":"<final text>","session_id":"...",
 *    "usage":{"input_tokens":N,"output_tokens":N,
 *              "cache_read_input_tokens":N,"cache_creation_input_tokens":N}}
 * The `result` event does not necessarily repeat `model` — it is read from
 * the `system`/`init` event instead (captured once per execute() run).
 * The parser below treats the claude-shaped fields as the primary path and
 * keeps looser aliases (camelCase usage, flat text fields, top-level
 * `tool_call`) only as a tolerant fallback for schema drift.
 *
 * UNCONFIRMED AT RUNTIME: whether `-p` reads the prompt from stdin. The
 * CLI's own --help only documents a positional `[prompt...]` argument, and
 * the live capture of the wire format above (run by a teammate, not from
 * this file) didn't specifically settle stdin-vs-argv for prompt delivery.
 * Until confirmed, the prompt is passed as a guarded positional argv
 * element instead of via stdin (unlike ClaudeSession, which confirmed
 * stdin works for `claude --print`). If stdin is later confirmed to work,
 * switch to `this.process.stdin.write(prompt)` to match ClaudeSession and
 * drop the length guard.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv, waitForStreamCompletion } from "./base-session"
import { planSandboxedSpawn } from "./sandbox"

export const CURSOR_COMMAND = "cursor-agent"

/**
 * Max prompt length (chars) accepted as a positional argv element.
 * Linux execve() caps a single argv/envp string at MAX_ARG_STRLEN
 * (128 KiB). This guard stays well under that on every supported
 * platform so a long issue description fails fast with an actionable
 * error instead of an opaque `E2BIG` from the kernel.
 */
export const MAX_PROMPT_ARG_LENGTH = 100_000

export class CursorSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  /** Model name captured from the `system`/`init` event's `model` field (e.g. "Fable 5 300K High"). */
  private capturedModel: string | undefined

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    if (prompt.length > MAX_PROMPT_ARG_LENGTH) {
      this.emitError(
        "CRASH",
        `CursorSession.execute: prompt is ${prompt.length} chars, exceeds MAX_PROMPT_ARG_LENGTH (${MAX_PROMPT_ARG_LENGTH}).\n` +
          "  Fix: shorten the issue/prompt template, or confirm cursor-agent reads stdin and switch\n" +
          "  cursor-session.ts to stdin (see the module docstring for the unconfirmed stdin path).",
        false,
      )
      return
    }

    this.filesChanged = []
    this.capturedModel = undefined
    this.startedAt = Date.now()

    const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--force"]

    if (this.config.model) {
      args.push("--model", this.config.model)
    }

    // Prompt is a positional argv element, not interpolated into a shell
    // string — spawn() passes args as an array, so this carries no shell
    // injection risk even though the prompt originates from untrusted
    // issue text (see docs/harness/SAFETY.md § 3, boundary validation is
    // the caller's responsibility before it reaches execute()).
    args.push(prompt)

    // Containment for --force comes from the OS sandbox wrapping this
    // spawn, not from trusting the flag itself. planSandboxedSpawn() fails
    // closed (throws) when no sandbox is available unless
    // SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: "cursor",
        command: CURSOR_COMMAND,
        args,
        workspacePath: this.config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    // CURSOR_API_KEY is not (yet) in base-session.ts's AGENT_ENV_KEYS map
    // for agentType "cursor" — that wiring belongs to the orchestrator per
    // the task boundary, not this file. Forward it here via buildAgentEnv's
    // `extra` param so auth still works standalone; never logged.
    const extraEnv: Record<string, string> = { ...this.config.env }
    const apiKey = process.env.CURSOR_API_KEY
    if (apiKey) extraEnv.CURSOR_API_KEY = apiKey

    this.process = spawn(plan.command, plan.args, {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("cursor", extraEnv) as NodeJS.ProcessEnv,
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
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event: unknown = JSON.parse(line)
          this.handleEvent(event)
        } catch {
          // Non-JSON stderr noise
        }
      }
    })

    proc.stdout.on("error", () => {
      // Stream error — proceed to close
    })

    // Gated on BOTH stdout 'end' and process 'close' — see
    // waitForStreamCompletion() doc comment in base-session.ts for why
    // 'close' alone races the final buffered 'data' chunk on a
    // fast-exiting process (this is the fix for the intermittent
    // truncated-output flakiness observed under heavy host load while
    // stress-testing this adapter).
    const { exitCode: code } = await waitForStreamCompletion(proc)
    const exitCode = code ?? -1

    if (exitCode !== 0) {
      this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `cursor-agent exited with code ${exitCode}`, exitCode !== 1)
    }
  }

  /**
   * `system`/`user` shapes are CONFIRMED live (see module docstring).
   * `assistant`/`result`/`usage` are claude-parity, high-confidence but
   * not directly observed — the primary parse path below matches those
   * confirmed-by-lineage shapes; looser aliases are kept only as a
   * tolerant fallback for schema drift, mirroring the "schema not
   * publicly pinned" tolerant approach already used in
   * codex-session.ts's extractTokenUsage.
   */
  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>

    switch (e.type) {
      case "system": {
        // Confirmed shape: {"type":"system","subtype":"init",...,"model":"..."}
        if (e.subtype === "init" && typeof e.model === "string") {
          this.capturedModel = e.model
        }
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        break
      }

      case "assistant": {
        this.handleAssistantEvent(e)
        break
      }

      case "tool_call": {
        // Fallback shape — the confirmed/claude-parity shape carries
        // tool_use as a content block inside `assistant` instead (handled
        // in handleAssistantEvent). Kept for schema-drift tolerance.
        this.handleToolCallEvent(e)
        break
      }

      case "result": {
        this.handleResultEvent(e)
        break
      }

      case "thinking":
      case "user":
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        break
    }
  }

  private handleAssistantEvent(e: Record<string, unknown>): void {
    // Confirmed-by-lineage shape: {"type":"assistant","message":{"content":[...]}}
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
          const args = (block.input as Record<string, unknown> | undefined) ?? {}
          this.emitToolUse(toolName, args)
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
    const toolCall = e.tool_call as Record<string, unknown> | undefined
    const toolName =
      (toolCall?.name as string | undefined) ??
      (e.name as string | undefined) ??
      (e.tool as string | undefined) ??
      "unknown"
    const args =
      (toolCall?.args as Record<string, unknown> | undefined) ??
      (e.args as Record<string, unknown> | undefined) ??
      (e.input as Record<string, unknown> | undefined) ??
      {}

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
    // Confirmed-by-lineage shape: {"type":"result","is_error":bool,"result":"...","usage":{...}}
    const result = (e.result as string | undefined) ?? (e.text as string | undefined) ?? ""
    const durationMs = (e.duration_ms as number | undefined) ?? (e.durationMs as number | undefined) ?? this.elapsedMs()
    const isError = e.is_error === true || e.isError === true

    if (isError) {
      this.emitError("CRASH", result || "cursor-agent reported an error result", true)
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
    const usage = (resultEvent.usage as Record<string, unknown> | undefined) ?? undefined
    if (!usage) return undefined

    // Primary path: claude-parity snake_case fields
    // (usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens).
    // camelCase / promptTokens/completionTokens kept only as a tolerant
    // fallback for schema drift.
    const input =
      (usage.input_tokens as number | undefined) ??
      (usage.inputTokens as number | undefined) ??
      (usage.promptTokens as number | undefined) ??
      0
    const output =
      (usage.output_tokens as number | undefined) ??
      (usage.outputTokens as number | undefined) ??
      (usage.completionTokens as number | undefined) ??
      0
    const cacheRead =
      (usage.cache_read_input_tokens as number | undefined) ?? (usage.cacheReadTokens as number | undefined) ?? 0
    const cacheCreation =
      (usage.cache_creation_input_tokens as number | undefined) ??
      (usage.cacheCreationTokens as number | undefined) ??
      0

    if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return undefined

    // The `result` event does not necessarily repeat `model` — fall back
    // to the model captured from the `system`/`init` event, then config.
    const model =
      (resultEvent.model as string | undefined) ??
      (usage.model as string | undefined) ??
      this.capturedModel ??
      this.config?.model ??
      "cursor"

    return {
      input: input + cacheRead + cacheCreation,
      output,
      model,
    }
  }
}
