"use client"

/**
 * InterventionPanel — Drawer UI that lets an operator pause / resume /
 * abort / append-prompt a running agent attempt.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.7 (C) and § 6.3 (E12).
 *
 * Capability-driven: buttons are disabled when the agent type does not
 * advertise support. The capability mapping mirrors the core's
 * `CAPABILITY_TABLE` (packages/core/src/sessions/adapters/spawn-agent-runner.ts)
 * so the dashboard can pre-filter actions without an extra round-trip.
 * When the core adds new agent types, extend both tables.
 */

import type { FormEvent } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"

export type InterventionKind = "pause" | "resume" | "append_prompt" | "abort"

export interface ActiveAttempt {
  attemptId: string
  issueKey: string
  agentType: string
}

const CAPS_BY_AGENT: Record<string, InterventionKind[]> = {
  claude: ["append_prompt", "abort"],
  codex: ["pause", "resume", "append_prompt", "abort"],
  gemini: ["append_prompt", "abort"],
}

function capabilitiesFor(agentType: string): InterventionKind[] {
  return CAPS_BY_AGENT[agentType] ?? ["append_prompt", "abort"]
}

interface InterventionPanelProps {
  attempt: ActiveAttempt | null
  onClose: () => void
  /** Optional override (used by tests). Defaults to the real fetch. */
  post?: (body: { attemptId: string; command: unknown }) => Promise<{ ok: boolean; message?: string }>
}

export function InterventionPanel({ attempt, onClose, post }: InterventionPanelProps) {
  const [promptText, setPromptText] = useState("")
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const caps = useMemo(() => (attempt ? capabilitiesFor(attempt.agentType) : []), [attempt])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const send = useCallback(
    async (command: unknown) => {
      if (!attempt) return
      setBusy(true)
      try {
        const doPost =
          post ??
          (async (body: { attemptId: string; command: unknown }) => {
            const res = await fetch("/api/intervention", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
            const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
            return { ok: res.ok, message: json.message ?? json.error }
          })
        const result = await doPost({ attemptId: attempt.attemptId, command })
        if (result.ok) {
          setToast({ kind: "ok", text: "Command dispatched" })
        } else {
          setToast({ kind: "err", text: result.message ?? "Command failed" })
        }
      } catch (err) {
        setToast({ kind: "err", text: err instanceof Error ? err.message : "Network error" })
      } finally {
        setBusy(false)
      }
    },
    [attempt, post],
  )

  if (!attempt) return null

  const disabled = (kind: InterventionKind) => busy || !caps.includes(kind)

  const onSubmitAppend = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!promptText.trim()) {
      setToast({ kind: "err", text: "Prompt text is required" })
      return
    }
    void send({ kind: "append_prompt", text: promptText }).then(() => {
      setPromptText("")
    })
  }

  return (
    <aside
      role="dialog"
      aria-label="Agent intervention"
      className="fixed top-0 right-0 h-full w-96 bg-gray-900/95 border-l border-gray-700 shadow-xl z-40 flex flex-col"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Intervene</h2>
          <p className="text-xs text-gray-400">
            {attempt.issueKey} · <span className="font-mono">{attempt.agentType}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-100 text-sm"
          aria-label="Close intervention panel"
        >
          Close
        </button>
      </header>

      <section className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled("pause")}
            onClick={() => void send({ kind: "pause" })}
            className="flex-1 text-xs rounded px-3 py-2 bg-yellow-700/30 hover:bg-yellow-700/50 text-yellow-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Pause
          </button>
          <button
            type="button"
            disabled={disabled("resume")}
            onClick={() => void send({ kind: "resume" })}
            className="flex-1 text-xs rounded px-3 py-2 bg-green-700/30 hover:bg-green-700/50 text-green-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Resume
          </button>
          <button
            type="button"
            disabled={disabled("abort")}
            onClick={() => void send({ kind: "abort", reason: "operator_requested" })}
            className="flex-1 text-xs rounded px-3 py-2 bg-red-700/40 hover:bg-red-700/60 text-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Abort
          </button>
        </div>

        <form onSubmit={onSubmitAppend} className="space-y-2">
          <label htmlFor="append-prompt-text" className="block text-xs text-gray-300">
            Append prompt
          </label>
          <textarea
            id="append-prompt-text"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            disabled={disabled("append_prompt")}
            rows={5}
            className="w-full text-xs rounded bg-gray-800 border border-gray-700 text-gray-100 p-2 disabled:opacity-40"
            placeholder="Additional instructions for the running agent..."
          />
          <button
            type="submit"
            disabled={disabled("append_prompt") || !promptText.trim()}
            className="w-full text-xs rounded px-3 py-2 bg-blue-700/40 hover:bg-blue-700/60 text-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send append_prompt
          </button>
        </form>

        <p className="text-[10px] leading-relaxed text-gray-500">
          Capabilities are advertised by the core per agent type. Unsupported actions are disabled.
          Claude is stateless — append_prompt cancels the current run and re-queues with the extra
          instruction.
        </p>
      </section>

      {toast ? (
        <footer
          role="status"
          className={`px-4 py-2 text-xs border-t ${
            toast.kind === "ok"
              ? "bg-green-900/40 border-green-700 text-green-100"
              : "bg-red-900/40 border-red-700 text-red-100"
          }`}
        >
          {toast.text}
        </footer>
      ) : null}
    </aside>
  )
}
