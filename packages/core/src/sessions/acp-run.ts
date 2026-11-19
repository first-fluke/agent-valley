/**
 * AcpRun — one agent run driven over the Agent Client Protocol (ACP v1).
 *
 * The agent process is spawned by the caller (through the OS sandbox); this
 * class only speaks JSON-RPC over its stdio with the official SDK. A run is
 * one ACP session: the task prompt, then any operator messages that arrive
 * while it works.
 *
 * ACP v1 is turn-based — an agent may refuse a second `session/prompt` while
 * one is active (OpenCode does) — so an operator message is delivered by
 * cancelling the active turn and prompting again in the same session, which
 * keeps the conversation. https://agentclientprotocol.com/protocol/v1/prompt-turn
 */

import type { ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  type ClientConnection,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk"
import { AV_VERSION } from "../version"
import { BoundedResultText } from "./native-result"

export interface AcpRunEvents {
  output(chunk: string): void
  toolUse(tool: string, args: Record<string, unknown>): void
  fileChange(path: string, changeType: "add" | "modify"): void
  /** Proof of life that carries nothing to show (thoughts, plans, usage). */
  activity(): void
}

export interface AcpRunOptions {
  cwd: string
  /** Model to select through the agent's session config, when it offers one. */
  model?: string
  /** Agent name for error messages, e.g. "OpenCode". */
  label: string
  events: AcpRunEvents
}

export interface AcpRunResult {
  output: string
  /** True when the final text outgrew the shared result bound and was dropped. */
  outputExceeded: boolean
  tokenUsage?: { input: number; output: number; model: string }
}

/** Wraps an operator message for the turn that follows an interrupted one. */
export function operatorInterruption(text: string): string {
  return (
    `The operator sent you a message while you were working:\n\n${text}\n\n` +
    "Take it into account. If your earlier work was interrupted, continue it now; otherwise act on this message."
  )
}

/** How long a CLI gets to answer the ACP handshake before it is treated as not speaking ACP. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 30_000

/** True when the agent answered a request with a JSON-RPC error, as opposed to never answering. */
export function isAcpAgentError(error: unknown): boolean {
  return error instanceof RequestError
}

type Json = Record<string, unknown>

export class AcpRun {
  private connection: ClientConnection | null = null
  private sessionId: string | null = null
  private model: string | undefined
  private pending: string[] = []
  private inFlight = false
  private cancelSent = false
  private finished = false
  private turnText = new BoundedResultText()
  private usage: { input: number; output: number } | null = null
  /** Tool calls seen this run: name, whether it edits files, and whether it was reported with its input yet. */
  private tools = new Map<string, { name: string; edits: boolean; reported: boolean }>()
  private changedFiles = new Set<string>()

  constructor(
    private readonly proc: ChildProcess,
    private readonly options: AcpRunOptions,
  ) {}

  /** Handshake and create the session. Rejects when the process does not speak ACP. */
  async open(timeoutMs = ACP_HANDSHAKE_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${this.options.label} did not answer the ACP handshake within ${timeoutMs}ms.`)),
        timeoutMs,
      )
    })
    try {
      const handshake = this.handshake()
      // If the timeout wins, the handshake still rejects later when the process is stopped.
      handshake.catch(() => {})
      await Promise.race([handshake, silent])
    } finally {
      clearTimeout(timer)
    }
  }

  private async handshake(): Promise<void> {
    const { stdin, stdout } = this.proc
    if (!stdin || !stdout) throw new Error(`${this.options.label} was started without stdio pipes; ACP needs both.`)
    const stream = ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
    )
    this.connection = client({ name: "agent-valley" })
      .onNotification(methods.client.session.update, ({ params }) => this.handleUpdate(params.update as Json))
      // The OS sandbox is the containment boundary, as with the one-shot auto-approve flags.
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const options = params.options as Array<{ optionId: string; kind: string }>
        const allow = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once")
        return allow
          ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" as const } }
      })
      .connect(stream)

    const agent = this.connection.agent
    await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // The agent keeps using its own file and shell tools inside the sandbox.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agent-valley", version: AV_VERSION },
    })
    const session = await agent.request(methods.agent.session.new, { cwd: this.options.cwd, mcpServers: [] })
    this.sessionId = session.sessionId
    await this.selectModel((session.configOptions ?? []) as Json[])
  }

  private async selectModel(configOptions: Json[]): Promise<void> {
    const option = configOptions.find((o) => o.category === "model" || o.id === "model")
    this.model = typeof option?.currentValue === "string" ? option.currentValue : undefined
    const wanted = this.options.model
    if (!wanted || wanted === this.model) return
    if (!option || typeof option.id !== "string") {
      throw new Error(
        `${this.options.label} does not let ACP clients choose a model, so "${wanted}" cannot be selected. Remove the actor's model or set it in the agent's own config.`,
      )
    }
    await this.agent().request(methods.agent.session.setConfigOption, {
      sessionId: this.session(),
      configId: option.id,
      value: wanted,
    })
    this.model = wanted
  }

  /**
   * Run the task to its end. Resolves after the last turn, including the turns
   * that answer operator messages; rejects when a turn fails or is cancelled
   * from outside.
   */
  async run(prompt: string): Promise<AcpRunResult> {
    this.pending.unshift(prompt)
    const outputs: string[] = []
    let exceeded = false
    try {
      while (this.pending.length > 0) {
        const text = this.pending.splice(0).join("\n\n")
        this.turnText.reset()
        this.inFlight = true
        this.cancelSent = false
        let response: Json
        try {
          response = (await this.agent().request(methods.agent.session.prompt, {
            sessionId: this.session(),
            prompt: [{ type: "text", text }],
          })) as Json
        } finally {
          this.inFlight = false
        }
        this.addUsage(response.usage as Json | undefined)
        if (response.stopReason === "cancelled") {
          // Our own interruption has the operator message queued; anything else came from outside.
          if (this.pending.length === 0) throw new Error(`${this.options.label} cancelled the run.`)
          continue
        }
        if (response.stopReason !== "end_turn") {
          throw new Error(
            `${this.options.label} stopped before finishing (${String(response.stopReason)}). Check the model's limits and retry.`,
          )
        }
        exceeded ||= this.turnText.exceeded
        const turnOutput = this.turnText.text.trim()
        if (turnOutput) outputs.push(turnOutput)
      }
    } finally {
      this.finished = true
    }
    return {
      output: exceeded ? "" : outputs.join("\n\n"),
      outputExceeded: exceeded,
      tokenUsage: this.usage ? { ...this.usage, model: this.model ?? this.options.model ?? "unknown" } : undefined,
    }
  }

  /** Queue an operator message, interrupting the active turn so it is read now. */
  async send(text: string): Promise<void> {
    if (!this.sessionId || this.finished) {
      throw new Error(
        `${this.options.label} is not accepting messages (the run has ended). Restart the run with the message instead.`,
      )
    }
    this.pending.push(operatorInterruption(text))
    if (this.inFlight && !this.cancelSent) {
      this.cancelSent = true
      await this.agent().notify(methods.agent.session.cancel, { sessionId: this.sessionId })
    }
  }

  get filesChanged(): string[] {
    return [...this.changedFiles]
  }

  close(): void {
    this.finished = true
    this.connection?.close()
  }

  private agent() {
    if (!this.connection) throw new Error(`${this.options.label} ACP connection is not open. Call open() first.`)
    return this.connection.agent
  }

  private session(): string {
    if (!this.sessionId) throw new Error(`${this.options.label} ACP session is not open. Call open() first.`)
    return this.sessionId
  }

  private addUsage(usage: Json | undefined): void {
    const input = usage?.inputTokens
    const output = usage?.outputTokens
    if (typeof input !== "number" || typeof output !== "number") return
    this.usage = { input: (this.usage?.input ?? 0) + input, output: (this.usage?.output ?? 0) + output }
  }

  private handleUpdate(update: Json): void {
    const { events } = this.options
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as Json | undefined
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          this.turnText.append(content.text)
          events.output(content.text)
        } else {
          events.activity()
        }
        return
      }
      case "tool_call":
      case "tool_call_update":
        this.handleToolCall(update)
        return
      default:
        events.activity()
    }
  }

  /**
   * A tool call starts as `pending`, often before its input is known, and later
   * updates fill it in. It is reported once, as soon as the input is there (or
   * when it ends without one).
   */
  private handleToolCall(update: Json): void {
    const { events } = this.options
    events.activity()
    const id = typeof update.toolCallId === "string" ? update.toolCallId : ""
    const known = this.tools.get(id) ?? {
      name: typeof update.title === "string" && update.title ? update.title : "tool",
      edits: false,
      reported: false,
    }
    // Later updates may omit the kind, so remember it from the ones that carry it.
    known.edits ||= update.kind === "edit"
    this.tools.set(id, known)

    const input = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Json) : {}
    const ended = update.status === "completed" || update.status === "failed"
    if (!known.reported && (Object.keys(input).length > 0 || ended)) {
      known.reported = true
      events.toolUse(known.name, input)
    }

    if (!known.edits) return
    const locations = Array.isArray(update.locations) ? (update.locations as Json[]) : []
    for (const location of locations) {
      if (typeof location.path !== "string" || this.changedFiles.has(location.path)) continue
      this.changedFiles.add(location.path)
      events.fileChange(location.path, /write|create/i.test(known.name) ? "add" : "modify")
    }
  }
}
