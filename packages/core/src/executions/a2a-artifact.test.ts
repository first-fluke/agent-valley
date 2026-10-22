import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { A2aSendResponse } from "../sessions/adapters/a2a-contracts"
import { clearedGitEnvironment } from "../util/git-environment"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import {
  type A2aArtifactBinding,
  type A2aArtifactJournal,
  applyA2aArtifacts,
  validateA2aAllowedPaths,
} from "./a2a-artifact"

const exec = promisify(execFile)
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
let root: string
let binding: A2aArtifactBinding
let saved: A2aArtifactJournal | undefined
let phases: string[]
const hooks = {
  load: async () => saved && structuredClone(saved),
  save: async (journal: A2aArtifactJournal) => {
    saved = structuredClone(journal)
    phases.push(journal.phase)
  },
}
async function git(...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, env: { ...process.env, ...clearedGitEnvironment } })).stdout.trim()
}
function file(path: string, content: string | null, executable = false) {
  return {
    path,
    contentBase64: content === null ? null : Buffer.from(content).toString("base64"),
    sha256: content === null ? null : digest(content),
    executable,
  }
}
function response(
  files = [file("src/value.txt", "after"), file("new.txt", "new", true), file("remove.txt", null)],
): A2aSendResponse {
  return {
    task: {
      id: "remote-task",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          artifactId: "delivery",
          parts: [
            {
              data: {
                agentValleyArtifact: {
                  version: 1,
                  attemptId: binding.attemptId,
                  requestSha256: binding.requestSha256,
                  repositoryId: binding.repositoryId,
                  baseRevision: binding.baseRevision,
                  files,
                },
              },
            },
          ],
        },
      ],
    },
  }
}
function envelope(value: A2aSendResponse): Record<string, unknown> {
  const data = value.task?.artifacts?.[0]?.parts[0]?.data
  if (!data) throw new Error("Missing fixture envelope")
  return (data as { agentValleyArtifact: Record<string, unknown> }).agentValleyArtifact
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-a2a-artifact-"))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/value.txt"), "before")
  await writeFile(join(root, "untouched.txt"), "retain")
  await writeFile(join(root, "remove.txt"), "remove")
  await git("init", "-q", "-b", "main")
  await git("config", "user.name", "Artifact fixture")
  await git("config", "user.email", "artifact@example.invalid")
  await git("add", ".")
  await git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline", "--no-gpg-sign")
  binding = {
    attemptId: "attempt-1",
    requestSha256: "a".repeat(64),
    repositoryId: "repository-1",
    baseRevision: await git("rev-parse", "HEAD"),
    baseFingerprint: await fingerprintWorkspace(root),
    allowedPaths: ["src/value.txt", "new.txt", "remove.txt"],
  }
  saved = undefined
  phases = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("A2A inline artifact gate", () => {
  it("rejects an already aborted operation before loading or mutating its journal", async () => {
    let loaded = false
    const controller = new AbortController()
    controller.abort(new Error("Operator interrupted"))
    await expect(
      applyA2aArtifacts(
        root,
        binding,
        response(),
        {
          ...hooks,
          load: async () => {
            loaded = true
            return saved
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("Operator interrupted")
    expect(loaded).toBe(false)
    expect(saved).toBeUndefined()
  })
  it("observes cancellation during asynchronous journal loading", async () => {
    const controller = new AbortController()
    await expect(
      applyA2aArtifacts(
        root,
        binding,
        response(),
        {
          ...hooks,
          load: async () => {
            controller.abort(new Error("Operator interrupted"))
            return saved
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("Operator interrupted")
    expect(saved).toBeUndefined()
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before")
  })
  it.each(["prepared", "applying", "applied"] as const)(
    "preserves the %s receipt on abort and resumes the identical record explicitly",
    async (phase) => {
      const controller = new AbortController()
      const reply = response()
      await expect(
        applyA2aArtifacts(
          root,
          binding,
          reply,
          {
            ...hooks,
            save: async (journal) => {
              await hooks.save(journal)
              if (journal.phase === phase) controller.abort(new Error("Operator interrupted"))
            },
          },
          controller.signal,
        ),
      ).rejects.toThrow("Operator interrupted")
      expect(saved?.phase).toBe(phase)
      expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe(phase === "applied" ? "after" : "before")
      const resumed = await applyA2aArtifacts(root, binding, reply, hooks)
      expect(saved?.phase).toBe("applied")
      expect(resumed.fingerprint).toBe(await fingerprintWorkspace(root))
    },
  )
  it("persists before applying create/update/delete bytes and executable mode, then repeats idempotently", async () => {
    const reply = response()
    const applied = await applyA2aArtifacts(root, binding, reply, hooks)
    expect(phases).toEqual(["prepared", "applying", "applied"])
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after")
    expect((await lstat(join(root, "new.txt"))).mode & 0o777).toBe(0o755)
    await expect(lstat(join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(applied.fingerprint).toBe(await fingerprintWorkspace(root))
    expect(await applyA2aArtifacts(root, binding, reply, hooks)).toEqual(applied)
    expect(phases).toHaveLength(3)
  })
  it.each([
    "../outside.txt",
    "/outside.txt",
    "src/../outside.txt",
    "src\\outside.txt",
    ".git/config",
    ".agents/agent.md",
    ".env",
    ".credentials.json",
    "secrets.production.yaml",
    "config/secrets.json",
    "av.yaml",
    "key.pem",
    "AGENTS.md",
  ])("rejects unsafe path %s before persisting or mutation", async (path) => {
    const changed = { ...binding, allowedPaths: [path] }
    await expect(applyA2aArtifacts(root, changed, response([file(path, "bad")]), hooks)).rejects.toThrow()
    expect(saved).toBeUndefined()
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before")
  })
  it("rejects paths not in the exact allowlist and case-colliding or overlapping allowlists", async () => {
    await expect(applyA2aArtifacts(root, binding, response([file("untouched.txt", "bad")]), hooks)).rejects.toThrow(
      "allowed",
    )
    expect(() => validateA2aAllowedPaths(["src/file", "SRC/file"])).toThrow("case")
    expect(() => validateA2aAllowedPaths(["src", "src/file"])).toThrow("overlap")
    expect(() => validateA2aAllowedPaths(Array.from({ length: 101 }, (_, index) => `file${index}`))).toThrow("100")
  })
  it.each(["attemptId", "requestSha256", "repositoryId", "baseRevision"] as const)(
    "rejects a foreign %s",
    async (key) => {
      const reply = response()
      envelope(reply)[key] = key.endsWith("Sha256")
        ? "b".repeat(64)
        : key === "baseRevision"
          ? "b".repeat(40)
          : "foreign"
      await expect(applyA2aArtifacts(root, binding, reply, hooks)).rejects.toThrow(key)
      expect(saved).toBeUndefined()
    },
  )
  it("rejects bad SHA, noncanonical base64 and mode metadata before mutation", async () => {
    const bad = file("src/value.txt", "after")
    bad.sha256 = "f".repeat(64)
    await expect(applyA2aArtifacts(root, binding, response([bad]), hooks)).rejects.toThrow("SHA256")
    const noncanonical = file("src/value.txt", "a")
    noncanonical.contentBase64 = "YQ"
    await expect(applyA2aArtifacts(root, binding, response([noncanonical]), hooks)).rejects.toThrow("canonical")
    const privileged = { ...file("src/value.txt", "after"), mode: 0o4755 }
    await expect(applyA2aArtifacts(root, binding, response([privileged]), hooks)).rejects.toThrow()
    expect(saved).toBeUndefined()
  })
  it("rejects missing/duplicate manifests, URLs, raw files and noncompleted tasks", async () => {
    for (const part of [{ url: "https://untrusted.invalid/file" }, { raw: "YWZ0ZXI=" }]) {
      const reply = response()
      reply.task?.artifacts?.[0]?.parts.push(part)
      await expect(applyA2aArtifacts(root, binding, reply, hooks)).rejects.toThrow("inline")
    }
    const duplicate = response()
    const parts = duplicate.task?.artifacts?.[0]?.parts
    if (parts?.[0]) parts.push(parts[0])
    await expect(applyA2aArtifacts(root, binding, duplicate, hooks)).rejects.toThrow("exactly one")
    await expect(
      applyA2aArtifacts(
        root,
        binding,
        { message: { messageId: "reply", role: "ROLE_AGENT", parts: [{ text: "done" }] } },
        hooks,
      ),
    ).rejects.toThrow("exactly one")
    const incomplete = response()
    if (incomplete.task) incomplete.task.status.state = "TASK_STATE_WORKING"
    await expect(applyA2aArtifacts(root, binding, incomplete, hooks)).rejects.toThrow("completed")
  })
  it.each(["file", "parent"])("rejects %s symlinks before any journal/write", async (kind) => {
    const target = kind === "file" ? "link.txt" : "linked/file.txt"
    await symlink(
      kind === "file" ? join(root, "untouched.txt") : join(root, "src"),
      join(root, kind === "file" ? "link.txt" : "linked"),
    )
    const changed = { ...binding, allowedPaths: [target], baseFingerprint: await fingerprintWorkspace(root) }
    await expect(applyA2aArtifacts(root, changed, response([file(target, "bad")]), hooks)).rejects.toThrow("symlink")
    expect(saved).toBeUndefined()
    expect(await readFile(join(root, "untouched.txt"), "utf8")).toBe("retain")
  })
  it("rejects a changed base HEAD even when the response retains the original binding", async () => {
    await writeFile(join(root, "untouched.txt"), "new commit")
    await git("add", "untouched.txt")
    await git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "changed base", "--no-gpg-sign")
    await expect(applyA2aArtifacts(root, binding, response(), hooks)).rejects.toThrow("HEAD")
    expect(saved).toBeUndefined()
  })
  it("rejects a changed base fingerprint", async () => {
    await writeFile(join(root, "untouched.txt"), "concurrent")
    await expect(applyA2aArtifacts(root, binding, response(), hooks)).rejects.toThrow("base fingerprint")
    expect(saved).toBeUndefined()
  })
  it("rejects submodules and privileged existing file modes", async () => {
    await chmod(join(root, "src/value.txt"), 0o4755)
    const changed = { ...binding, baseFingerprint: await fingerprintWorkspace(root) }
    await expect(applyA2aArtifacts(root, changed, response(), hooks)).rejects.toThrow("privileged")
    await chmod(join(root, "src/value.txt"), 0o644)
    await mkdir(join(root, "nested"))
    await git("update-index", "--add", "--cacheinfo", `160000,${binding.baseRevision},nested`)
    await expect(applyA2aArtifacts(root, binding, response(), hooks)).rejects.toThrow("submodule")
    expect(saved).toBeUndefined()
  })
  it("persists no product mutation when journal storage fails", async () => {
    await expect(
      applyA2aArtifacts(root, binding, response(), {
        ...hooks,
        save: async () => {
          throw new Error("disk unavailable")
        },
      }),
    ).rejects.toThrow("disk unavailable")
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before")
  })
  it("recovers an interrupted subset only from original/desired bytes and modes", async () => {
    const reply = response()
    await expect(
      applyA2aArtifacts(root, binding, reply, {
        ...hooks,
        save: async (journal) => {
          await hooks.save(journal)
          if (journal.phase === "applying") throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    await writeFile(join(root, "src/value.txt"), "after")
    const result = await applyA2aArtifacts(root, binding, reply, hooks)
    expect(result.fingerprint).toBe(await fingerprintWorkspace(root))
    expect(saved?.phase).toBe("applied")
  })
  it.each(["target", "mode", "outside"])("rejects concurrent %s changes after durable preparation", async (kind) => {
    const reply = response()
    await expect(
      applyA2aArtifacts(root, binding, reply, {
        ...hooks,
        save: async (journal) => {
          await hooks.save(journal)
          if (journal.phase === "applying") throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    if (kind === "target") await writeFile(join(root, "src/value.txt"), "foreign")
    if (kind === "mode") await chmod(join(root, "src/value.txt"), 0o600)
    if (kind === "outside") await writeFile(join(root, "untouched.txt"), "foreign")
    await expect(applyA2aArtifacts(root, binding, reply, hooks)).rejects.toThrow(/changed/)
  })
  it("rechecks after persistence callbacks and preserves rejected application evidence", async () => {
    await expect(
      applyA2aArtifacts(root, binding, response(), {
        ...hooks,
        save: async (journal) => {
          await hooks.save(journal)
          if (journal.phase === "applying") await writeFile(join(root, "src/value.txt"), "foreign")
        },
      }),
    ).rejects.toThrow("changed")
    expect(saved?.phase).toBe("applying")
    await expect(lstat(join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("rejects changed manifests, journal hashes and previously applied files", async () => {
    const reply = response()
    await applyA2aArtifacts(root, binding, reply, hooks)
    await expect(
      applyA2aArtifacts(root, binding, response([file("src/value.txt", "different")]), hooks),
    ).rejects.toThrow("journal")
    if (!saved) throw new Error("Missing saved journal")
    const original = structuredClone(saved)
    saved.manifestSha256 = "f".repeat(64)
    await expect(applyA2aArtifacts(root, binding, reply, hooks)).rejects.toThrow("journal")
    saved = original
    await writeFile(join(root, "src/value.txt"), "before")
    await expect(applyA2aArtifacts(root, binding, reply, hooks)).rejects.toThrow("changed")
  })
  it("bounds file bytes and aggregate decoded bytes before persistence", async () => {
    const bytes = "x".repeat(1024 * 1024 + 1)
    await expect(applyA2aArtifacts(root, binding, response([file("src/value.txt", bytes)]), hooks)).rejects.toThrow()
    const names = Array.from({ length: 5 }, (_, index) => `chunk${index}.txt`)
    await expect(
      applyA2aArtifacts(
        root,
        { ...binding, allowedPaths: names },
        response(names.map((name) => file(name, "x".repeat(1024 * 1024)))),
        hooks,
      ),
    ).rejects.toThrow("4 MiB")
    expect(saved).toBeUndefined()
  })
})
