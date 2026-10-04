import type { Readable, Writable } from "node:stream"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import type { AvMcpOptions, MissionApiPort } from "./mcp-contract"
import { createAvMcpServer } from "./mcp-tools"

export interface AvMcpHandle {
  close(): Promise<void>
}

/** Only the SDK transport writes stdout. Disconnect closes this API, leaving detached missions durable. */
export async function startAvMcpStdio(
  api: MissionApiPort,
  options: AvMcpOptions & { stdin?: Readable; stdout?: Writable; signals?: boolean },
): Promise<AvMcpHandle> {
  const diagnostic = options.diagnostic ?? ((message: string) => process.stderr.write(`${message}\n`))
  const transport = new StdioServerTransport(options.stdin, options.stdout, { maxBufferSize: 1_048_576 })
  const server = serveStdio(() => createAvMcpServer(api, options), {
    transport,
    onerror: (error) => diagnostic(error.message),
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
      try {
        await server.close()
      } finally {
        await api.close()
      }
    })
    return closing
  }
  const stop = () => {
    void close().catch((error: unknown) => diagnostic(error instanceof Error ? error.message : "MCP shutdown failed."))
  }
  const onclose = transport.onclose
  transport.onclose = () => {
    onclose?.()
    stop()
  }
  if (options.signals !== false) {
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  }
  return { close }
}
