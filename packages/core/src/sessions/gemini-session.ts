/**
 * GeminiSession — Gemini CLI integration with ACP or CLI fallback.
 *
 * Primary: --experimental-acp (Agent Communication Protocol) — persistent session
 * Fallback: --yolo --output-format json — one-shot per execute()
 *
 * In fallback mode, each execute() spawns a new gemini process (like ClaudeSession).
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv } from "./base-session"

export class GeminiSession extends BaseSession {
  private output = ""
  private filesChanged: string[] = []
  private useAcp = false
  private started = false
  private acpSupportCache: boolean | null = null

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.useAcp = config.options?.useAcp === true && (await this.detectAcpSupport())
    this.started = true

    if (this.useAcp) {
      // ACP mode: persistent process
      this.startedAt = Date.now()
      const args = this.buildAcpArgs(config)

      this.process = spawn("gemini", args, {
        cwd: config.workspacePath,
        env: buildAgentEnv("gemini", config.env) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      })
    }
    // Fallback mode: process spawned per execute() call
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    this.output = ""
    this.filesChanged = []

    if (this.useAcp) {
      if (!this.assertStarted()) return
      const message = JSON.stringify({ type: "prompt", content: prompt })
      this.process?.stdin?.write(`${message}\n`)
    } else {
      await this.runOneShotWithPrompt(prompt)
    }
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return this.process.exitCode === null
  }

  // ── Live intervention (C) ──────────────────────────────────────────────

  /**
   * Send a mid-run user message when running in ACP mode. In CLI
   * fallback mode this throws — the caller (spawn-agent-runner) must
   * fall back to the Claude-style cancel + respawn strategy.
   */
  async sendUserMessage(text: string): Promise<void> {
    if (!this.useAcp) {
      throw new Error(
        "GeminiSession.sendUserMessage: CLI fallback mode is stateless.\n" +
          "  Fix: enable options.useAcp=true in the agent config to use persistent ACP mode,\n" +
          "  or dispatch via cancel + respawn at the runner layer.",
      )
    }
    if (!this.process?.stdin) {
      throw new Error(
        "GeminiSession.sendUserMessage: ACP session has no stdin.\n" +
          "  Fix: ensure start() was called successfully before appending prompts.",
      )
    }
    const message = JSON.stringify({ type: "prompt", content: text })
    this.process.stdin.write(`${message}\n`)
  }

  // ── Args builders ───────────────────────────────────────────────────────

  private buildAcpArgs(config: AgentConfig): string[] {
    const args = ["--experimental-acp"]
    if (config.model) args.push("--model", config.model)
    const approvalMode = config.options?.approvalMode as string | undefined
    if (approvalMode) args.push("--approval-mode", approvalMode)
    return args
  }

  private buildFallbackArgs(config: AgentConfig): string[] {
    const args = ["--yolo", "--output-format", "json"]
    if (config.model) args.push("--model", config.model)
    return args
  }

  // ── Fallback: one-shot execution ────────────────────────────────────────

  private async runOneShotWithPrompt(prompt: string): Promise<void> {
    this.startedAt = Date.now()

    if (!this.config) throw new Error("GeminiSession: start() must be called before execute()")
    const config = this.config
    const args = this.buildFallbackArgs(config)

    // Pass prompt via stdin to avoid CLI arg injection and temp file issues
    this.process = spawn("gemini", args, {
      cwd: config.workspacePath,
      env: buildAgentEnv("gemini", config.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"], // gemini outputs heavy MCP noise to stderr — ignore to prevent pipe blocking
    })

    this.process.stdin?.write(prompt, "utf-8")
    this.process.stdin?.end()

    try {
      await this.readFallbackOutput()
    } catch (err) {
      this.emitError("CRASH", `readFallbackOutput failed: ${err}`, true)
    }
  }

  private readFallbackOutput(): Promise<void> {
    return new Promise((resolve) => {
      const proc = this.process
      if (!proc?.stdout) {
        this.emitError("CRASH", "gemini process has no stdout", false)
        resolve()
        return
      }

      // Collect all stdout
      const decoder = new TextDecoder()
      let raw = ""

      proc.stdout.on("data", (chunk: Buffer) => {
        raw += decoder.decode(chunk, { stream: true })
      })

      proc.stdout.on("error", () => {
        // Stream error — proceed to close
      })

      proc.once("close", (code) => {
        const exitCode = code ?? -1

        // Parse the JSON response (gemini outputs a single JSON object)
        if (exitCode === 0) {
          let parsed: Record<string, unknown> | null = null
          try {
            // Find the JSON object in the output (skip stderr-like noise that leaked to stdout)
            const jsonStart = raw.indexOf("{")
            if (jsonStart >= 0) {
              const jsonStr = raw.slice(jsonStart)
              parsed = JSON.parse(jsonStr) as Record<string, unknown>
              this.output = (parsed.response as string | undefined) ?? (parsed.text as string | undefined) ?? raw
            } else {
              this.output = raw
            }
          } catch {
            this.output = raw
          }

          // CLI fallback has no stable usage surface. Only emit token
          // usage when the JSON response embeds `usageMetadata` (ACP-ish
          // payload echoed by some Gemini builds); otherwise leave
          // tokenUsage undefined so BudgetService skips accumulation.
          const result = this.buildRunResult(this.output, this.filesChanged)
          const usage = parsed ? extractGeminiUsage(parsed, this.config?.model) : undefined
          if (usage) result.tokenUsage = usage

          this.emit({ type: "output", chunk: this.output })
          this.emit({ type: "complete", result })
        } else {
          this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `gemini exited with code ${exitCode}`, true)
        }

        resolve()
      })
    })
  }

  // ── ACP detection (cached per instance) ───────────────────────────────

  private async detectAcpSupport(): Promise<boolean> {
    if (this.acpSupportCache !== null) return this.acpSupportCache

    // ACP is experimental and not reliably detectable via --help (always exits 0).
    // Disable ACP by default until Gemini CLI stabilizes ACP support.
    // Users can opt in via config.options.useAcp = true.
    this.acpSupportCache = false
    return this.acpSupportCache
  }
}

/**
 * Extract Gemini token usage from a parsed CLI JSON response or an ACP
 * message. Checks both `usageMetadata` (ACP / generateContent response
 * shape: promptTokenCount + candidatesTokenCount) and
 * `generationStats` (older CLI builds: promptTokenCount +
 * candidatesTokenCount). Returns `undefined` when no usage block is
 * present, triggering the BudgetService skip path (docs/plans/v0-2-bigbang-design.md § 6.4 E19).
 *
 * Note: this parser is estimated — Gemini has published multiple
 * response shapes across SDK versions. Fields that remain zero are
 * treated as "no usage recorded" to avoid polluting the budget ledger.
 */
export function extractGeminiUsage(
  payload: Record<string, unknown>,
  fallbackModel?: string,
): { input: number; output: number; model: string } | undefined {
  const candidate =
    (payload.usageMetadata as Record<string, unknown> | undefined) ??
    (payload.generationStats as Record<string, unknown> | undefined)
  if (!candidate) return undefined
  const input =
    (candidate.promptTokenCount as number | undefined) ??
    (candidate.prompt_token_count as number | undefined) ??
    (candidate.input as number | undefined) ??
    0
  const output =
    (candidate.candidatesTokenCount as number | undefined) ??
    (candidate.candidates_token_count as number | undefined) ??
    (candidate.output as number | undefined) ??
    0
  if (input === 0 && output === 0) return undefined
  const model =
    (payload.model as string | undefined) ?? (candidate.model as string | undefined) ?? fallbackModel ?? "gemini"
  return { input, output, model }
}
