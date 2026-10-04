import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { AV_VERSION } from "@agent-valley/core/version"
import { type CallToolResult, McpServer, ResourceTemplate } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  type AvMcpOptions,
  type MissionApiPort,
  mcpOrderSchema,
  mcpResumeSchema,
  missionIdSchema,
  missionReportUri,
} from "./mcp-contract"

const identity = z.strictObject({ missionId: missionIdSchema })
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

async function toolResult(action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await action()
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : "Mission operation failed." }],
    }
  }
}

/** Protocol only: the injected service owns process lifecycle and durable mission state. */
export function createAvMcpServer(api: MissionApiPort, options: AvMcpOptions): McpServer {
  const managed = (options.env ?? process.env).AGENT_VALLEY_MANAGED_RUN === "1"
  const server = new McpServer(
    { name: "agent-valley", version: AV_VERSION },
    {
      maxToolInputElements: 100,
      instructions:
        "Submit goals to av_order, then inspect av_status and av_report. Orders execute asynchronously. Reports describe actual evidence and remaining blockers. Each server is bound to one workspace. av_missions includes the server executionContext; managed servers forbid nested orders and resumes.",
    },
  )
  const assertManaged = () => {
    if (managed)
      throw new Error(
        "Managed Actors cannot start or resume nested AV missions. Return findings to the supervising Chief Director.",
      )
  }
  server.registerTool(
    "av_order",
    {
      description:
        "Start a durable Chief Director mission in the configured repository and return its identity immediately. requestId deduplicates repeated submissions. verify is an optional trusted completion command executed by the mission.",
      inputSchema: mcpOrderSchema,
      annotations: write,
    },
    (input) =>
      toolResult(async () => {
        assertManaged()
        const workspace = await realpath(resolve(options.workspace))
        if (input.workspace && (await realpath(resolve(workspace, input.workspace))) !== workspace)
          throw new Error(
            "This MCP server is bound to its configured --workspace. Start a separate AV MCP server for another repository.",
          )
        return api.order({ ...input, workspace })
      }),
  )
  server.registerTool(
    "av_missions",
    {
      description:
        "List durable missions, the bound project/workspace and server executionContext. managed=true forbids nested mission creation or resume.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    () =>
      toolResult(async () => ({
        ...(await api.list()),
        executionContext: { managed, delegationAllowed: !managed },
      })),
  )
  server.registerTool(
    "av_status",
    {
      description: "Read a mission's current state, task progress, actual verification evidence and blockers.",
      inputSchema: identity,
      annotations: readOnly,
    },
    ({ missionId }) => toolResult(() => api.status(missionId)),
  )
  server.registerTool(
    "av_report",
    {
      description:
        "Read the actual Markdown report, including its easy explanation and evidence. The report is also an MCP resource.",
      inputSchema: identity,
      annotations: readOnly,
    },
    ({ missionId }) => toolResult(async () => ({ ...(await api.report(missionId)), uri: missionReportUri(missionId) })),
  )
  server.registerTool(
    "av_resume",
    {
      description:
        "Resume the original durable mission after operator retry or increased budgets. Its goal, Actors and acceptance checks remain fixed. requestId deduplicates repeated submissions.",
      inputSchema: mcpResumeSchema,
      annotations: write,
    },
    (input) =>
      toolResult(async () => {
        assertManaged()
        return api.resume(input)
      }),
  )
  server.registerTool(
    "av_cancel",
    {
      description:
        "Request a running mission to stop and return cancelRequested plus its current checkpoint. The supervisor finishes cleanup asynchronously; poll av_status until paused before retrying.",
      inputSchema: identity,
      annotations: { ...write, idempotentHint: true, openWorldHint: false },
    },
    ({ missionId }) => toolResult(() => api.cancel(missionId)),
  )
  server.registerResource(
    "mission-report",
    new ResourceTemplate("av://missions/{missionId}/report", { list: undefined }),
    {
      description: "Actual Chief Director Markdown report with observed evidence and remaining work.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const missionId = missionIdSchema.parse(variables.missionId)
      const report = await api.report(missionId)
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: report.markdown }] }
    },
  )
  return server
}
