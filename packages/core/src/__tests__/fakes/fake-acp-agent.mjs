/**
 * Scripted ACP agent for session tests. Speaks real ACP over stdio through the
 * official SDK's agent side, so the client under test is exercised end to end.
 *
 * usage: <runtime> fake-acp-agent.mjs <scenario.json>
 *
 * Scenario:
 *   models        string[]   model ids offered as a session config option (first is current)
 *   refuseSession string     session/new answers with this JSON-RPC error message
 *   refusePromptWhileBusy    answer a second prompt during an active one with an error
 *   turns         Turn[]     one entry per prompt, in order (the last repeats)
 * Turn:
 *   steps  Array of { text } | { tool: ToolCallUpdate } | { echoPrompt } | { askPermission }
 *          | { waitForCancel } | { sleep: ms }
 *   stop   stop reason (default "end_turn"); usage  { inputTokens, outputTokens }
 *   error  answer the prompt with this JSON-RPC error message instead
 */

import { readFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { agent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk"

const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"))
const sessionId = "session-1"
let promptCount = 0
let active = false
let cancelled = false
let wakeCancel = () => {}
let model = scenario.models?.[0]

const modelOption = () =>
  scenario.models
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: scenario.models.map((value) => ({ value, name: value })),
        },
      ]
    : undefined

agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "Fake", version: "0.0.0" },
  }))
  .onRequest(methods.agent.session.new, () => {
    if (scenario.refuseSession) throw new RequestError(-32603, scenario.refuseSession)
    return { sessionId, configOptions: modelOption() }
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    model = params.value
    return { configOptions: modelOption() ?? [] }
  })
  .onNotification(methods.agent.session.cancel, () => {
    cancelled = true
    wakeCancel()
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (active && scenario.refusePromptWhileBusy) {
      throw new RequestError(-32603, `Session already has an active ACP prompt: ${sessionId}`)
    }
    const turn = scenario.turns[Math.min(promptCount, scenario.turns.length - 1)]
    promptCount++
    active = true
    cancelled = false
    const update = (body) => client.notify(methods.client.session.update, { sessionId, update: body })
    const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
    try {
      if (turn.error) throw new RequestError(-32603, turn.error)
      for (const step of turn.steps ?? []) {
        if (step.text !== undefined) await say(step.text)
        if (step.tool) await update(step.tool)
        if (step.echoPrompt) await say(`[model=${model}] ${params.prompt.map((block) => block.text).join("")}`)
        if (step.askPermission) {
          const answer = await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: "permission-1", title: "write", kind: "edit", status: "pending" },
            options: [
              { optionId: "reject", name: "Reject", kind: "reject_once" },
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
            ],
          })
          await say(`permission=${answer.outcome.optionId ?? answer.outcome.outcome}`)
        }
        if (step.waitForCancel) {
          while (!cancelled) {
            await new Promise((resolve) => {
              wakeCancel = resolve
            })
          }
          return { stopReason: "cancelled", usage: turn.usage }
        }
        if (step.sleep) await new Promise((resolve) => setTimeout(resolve, step.sleep))
      }
      return { stopReason: turn.stop ?? "end_turn", usage: turn.usage }
    } finally {
      active = false
    }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
