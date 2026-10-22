import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { A2aEndpoint } from "../../sessions/adapters/a2a-contracts"
import type { A2aJob } from "../a2a-job"
import { A2aJobStore } from "../a2a-store"

const exec = promisify(execFile)
export async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "av-a2a-service-"))
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.name", "A2A test"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root })
  await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
  await writeFile(join(root, "result.txt"), "0\n")
  await writeFile(
    join(root, "verify.cjs"),
    `const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='42\\n')process.exit(1);if(process.env.A2A_VERIFY_FAIL==='1')process.exit(2);`,
  )
  await exec("git", ["add", ".gitignore", "result.txt", "verify.cjs"], { cwd: root })
  await exec("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"], { cwd: root })
  return realpath(root)
}

export function artifactResponse(job: A2aJob, text = "42\n") {
  const bytes = Buffer.from(text)
  return {
    id: "remote-task",
    contextId: "remote-context",
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [
      {
        artifactId: "delivery",
        parts: [
          {
            data: {
              agentValleyArtifact: {
                version: 1,
                attemptId: job.id,
                requestSha256: job.requestSha256,
                repositoryId: job.repositoryId,
                baseRevision: job.baseRevision,
                files: [
                  {
                    path: "result.txt",
                    contentBase64: bytes.toString("base64"),
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                    executable: false,
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  }
}

export interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}
export async function fixtureEndpoint(
  root: string,
  handle: (rpc: RpcRequest, job: A2aJob, response: ServerResponse) => unknown | Promise<unknown>,
) {
  const requests: RpcRequest[] = []
  let endpoint: A2aEndpoint
  const server = createServer(async (request: IncomingMessage, response) => {
    response.setHeader("Content-Type", "application/json")
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          name: "Fixture",
          description: "Local protocol integration fixture",
          version: "1.0.0",
          supportedInterfaces: [{ url: endpoint.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
          capabilities: {},
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["application/json"],
          skills: [],
        }),
      )
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rpc = JSON.parse(Buffer.concat(chunks).toString()) as RpcRequest
    requests.push(rpc)
    try {
      const job = (await new A2aJobStore(root).list())[0]
      if (!job) {
        response.writeHead(500).end()
        return
      }
      const result = await handle(rpc, job, response)
      if (!response.destroyed && !response.writableEnded)
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
    } catch {
      response.destroy()
    }
  })
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture server has no port")
  endpoint = {
    id: "fixture",
    url: `http://127.0.0.1:${address.port}/rpc`,
    allowHttpLoopback: true,
    requestTimeoutMs: 5_000,
    pollIntervalMs: 1,
  }
  return {
    endpoint,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
    saved: async () => (await new A2aJobStore(root).list())[0] as A2aJob,
    bytes: async () => readFile(join(root, "result.txt"), "utf8"),
  }
}
