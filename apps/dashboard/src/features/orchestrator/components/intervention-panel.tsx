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

import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  const caps = useMemo(() => (attempt ? capabilitiesFor(attempt.agentType) : []), [attempt])

  // Focus management: move focus into the drawer on open, restore it to
  // whatever triggered the drawer (e.g. the Active Agents list item) on
  // close — required so keyboard/screen-reader users don't lose their place.
  useEffect(() => {
    if (!attempt) return
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)

    return () => {
      document.removeEventListener("keydown", onKeyDown)
      previouslyFocusedRef.current?.focus()
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: onClose identity churn should not re-run focus setup
  }, [attempt])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Minimal focus trap: keep Tab/Shift+Tab cycling within the drawer while open.
  const onTrapKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [href], input:not([disabled])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  const send = useCallback(
    async (command: unknown) => {
      if (!attempt) return
      setBusy(true)
      try {
        const doPost =
          post ??
          (async (body: { attemptId: string; command: unknown }) => {
            // TODO(oma-deferred): once a client-exposed intervention token
            // mechanism lands (SYMPHONY_INTERVENTION_TOKEN, see
            // apps/dashboard/src/lib/dashboard-auth.ts), add an
            // `Authorization: Bearer <token>` header here. Local/localhost
            // requests without a token continue to work by design.
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
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Agent intervention"
      onKeyDown={onTrapKeyDown}
      className="fixed top-0 right-0 h-full w-96 bg-gray-900/95 border-l border-gray-700 shadow-xl z-40 flex flex-col motion-reduce:transition-none"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Intervene</h2>
          <p className="text-xs text-gray-400">
            {attempt.issueKey} · <span className="font-mono">{attempt.agentType}</span>
          </p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-100 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
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
            className="flex-1 text-xs rounded px-3 py-2 bg-yellow-700/30 hover:bg-yellow-700/50 text-yellow-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            Pause
          </button>
          <button
            type="button"
            disabled={disabled("resume")}
            onClick={() => void send({ kind: "resume" })}
            className="flex-1 text-xs rounded px-3 py-2 bg-green-700/30 hover:bg-green-700/50 text-green-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            Resume
          </button>
          <button
            type="button"
            disabled={disabled("abort")}
            onClick={() => void send({ kind: "abort", reason: "operator_requested" })}
            className="flex-1 text-xs rounded px-3 py-2 bg-red-700/40 hover:bg-red-700/60 text-red-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
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
            className="w-full text-xs rounded bg-gray-800 border border-gray-700 text-gray-100 p-2 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
            placeholder="Additional instructions for the running agent..."
          />
          <button
            type="submit"
            disabled={disabled("append_prompt") || !promptText.trim()}
            className="w-full text-xs rounded px-3 py-2 bg-blue-700/40 hover:bg-blue-700/60 text-blue-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
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
