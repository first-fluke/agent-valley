/**
 * sandbox.test.ts — Sandbox command construction + fail-closed/opt-in gating.
 *
 * Mocks platform + binary availability throughout — never requires the
 * real sandbox-exec/bwrap binaries to be installed to run.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import { logger } from "../observability/logger"
import { mergeAndPush, pushBranch } from "../workspace/delivery-strategy"
import { cleanupWorkspace, createWorkspace, detectUnfinishedWork, getDiffStat } from "../workspace/worktree-lifecycle"
import {
  ALLOW_UNSANDBOXED_ENV_VAR,
  DEFAULT_NETWORK_ALLOWLIST,
  isUnsandboxedFallbackAllowed,
  NETWORK_ALLOWLIST_ENV_VAR,
  planSandboxedSpawn,
  resolveNetworkAllowlist,
} from "./sandbox"
import { resolveBinaryPath } from "./sandbox-binary"
import { buildDarwinSandboxCommand, resetSandboxExecCache } from "./sandbox-darwin"
import { linkedWorktreeGitPaths } from "./sandbox-git"
import { buildLinuxSandboxCommand, resetBwrapCache } from "./sandbox-linux"

const BASE_REQUEST = {
  agentType: "claude",
  command: "claude",
  args: ["--print", "--dangerously-skip-permissions"],
  workspacePath: "/workspaces/ACR-42",
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function withGitWorktrees(run: (paths: { repo: string; first: string; second: string }) => void): void {
  const fixture = mkdtempSync(join(process.cwd(), ".sandbox-git-test-"))
  const repo = join(fixture, "repo")
  const first = join(fixture, "issue-one")
  const second = join(fixture, "issue-two")
  try {
    mkdirSync(repo)
    git(repo, "init", "-q")
    writeFileSync(join(repo, "file.txt"), "base\n")
    git(repo, "add", "file.txt")
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
    git(repo, "worktree", "add", "-qb", "feature/ONE", first)
    git(repo, "worktree", "add", "-qb", "feature/TWO", second)
    run({ repo, first, second })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

describe("resolveNetworkAllowlist", () => {
  test("returns the default allowlist when no env override is set", () => {
    expect(resolveNetworkAllowlist({})).toEqual([...DEFAULT_NETWORK_ALLOWLIST])
  })

  test("merges operator-configured extra domains, de-duplicated", () => {
    const result = resolveNetworkAllowlist({
      [NETWORK_ALLOWLIST_ENV_VAR]: "internal.example.com, api.anthropic.com , second.example.com",
    })
    expect(result).toContain("internal.example.com")
    expect(result).toContain("second.example.com")
    expect(result.filter((d) => d === "api.anthropic.com")).toHaveLength(1)
  })
})

describe("isUnsandboxedFallbackAllowed", () => {
  test("false by default (fail-closed default)", () => {
    expect(isUnsandboxedFallbackAllowed({})).toBe(false)
  })

  test("false for any value other than the literal '1'", () => {
    expect(isUnsandboxedFallbackAllowed({ [ALLOW_UNSANDBOXED_ENV_VAR]: "true" })).toBe(false)
  })

  test("true only when explicitly set to '1'", () => {
    expect(isUnsandboxedFallbackAllowed({ [ALLOW_UNSANDBOXED_ENV_VAR]: "1" })).toBe(true)
  })
})

describe("sandbox-binary resolveBinaryPath", () => {
  test("finds a binary via an absolute candidate path", () => {
    expect(resolveBinaryPath("sh", ["/bin/sh"])).toBe("/bin/sh")
  })

  test("returns null for a binary that does not exist anywhere", () => {
    expect(
      resolveBinaryPath("definitely-not-a-real-binary-xyz-123", ["/nowhere/definitely-not-a-real-binary-xyz-123"]),
    ).toBeNull()
  })
})

describe("buildDarwinSandboxCommand", () => {
  test("wraps the base command in sandbox-exec with a Seatbelt profile", () => {
    const result = buildDarwinSandboxCommand(
      { ...BASE_REQUEST, networkAllowlist: ["api.anthropic.com"] },
      "/usr/bin/sandbox-exec",
    )
    expect(result.command).toBe("/usr/bin/sandbox-exec")
    expect(result.args[0]).toBe("-p")
    const profile = result.args[1] as string
    expect(profile).toContain("(deny default)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain(BASE_REQUEST.workspacePath)
    // Domain-scoped `(remote tcp "host:port")` rules crash sandbox-exec on
    // current macOS ("host must be * or localhost in network address") —
    // verified empirically. The profile must therefore only ever emit
    // wildcard-host, port-scoped network rules, never a literal hostname.
    expect(profile).not.toMatch(/remote tcp "[a-zA-Z]/)
    expect(profile).toContain('(remote tcp "*:443")')
    expect(profile).toContain('(remote tcp "*:80")')
    // Original command + args are appended after the profile.
    expect(result.args.slice(-BASE_REQUEST.args.length - 1)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("escapes quotes in paths so the profile stays syntactically valid", () => {
    const result = buildDarwinSandboxCommand(
      { ...BASE_REQUEST, workspacePath: '/workspaces/weird"path', networkAllowlist: [] },
      "/usr/bin/sandbox-exec",
    )
    const profile = result.args[1] as string
    expect(profile).toContain('\\"path')
  })

  test("denies read access to ~/.config/agent-valley despite the broad file-read* allow", () => {
    const result = buildDarwinSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "/usr/bin/sandbox-exec")
    const profile = result.args[1] as string
    const agentValleyConfig = `${homedir()}/.config/agent-valley`
    expect(profile).toContain(`(deny file-read* (subpath "${agentValleyConfig}"))`)
    // The deny rule must appear AFTER the broad allow — Seatbelt is
    // last-match-wins, so ordering is what makes the deny effective.
    expect(profile.indexOf("(allow file-read*)")).toBeLessThan(
      profile.indexOf(`(deny file-read* (subpath "${agentValleyConfig}"))`),
    )
  })

  test("denies read access to the project's valley.yaml, ~/.ssh, and ~/.git-credentials", () => {
    const result = buildDarwinSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "/usr/bin/sandbox-exec")
    const profile = result.args[1] as string
    expect(profile).toContain(`(deny file-read* (subpath "${homedir()}/.ssh"))`)
    expect(profile).toContain(`(deny file-read* (literal "${homedir()}/.git-credentials"))`)
    expect(profile).toContain(`(deny file-read* (literal "${join(process.cwd(), "valley.yaml")}"))`)
  })

  test.skipIf(process.platform !== "darwin")(
    "denies synthetic relay credentials even inside a writable workspace",
    () => {
      const fixture = mkdtempSync(join(process.cwd(), ".sandbox-credential-test-"))
      const fakeHome = join(fixture, "home")
      const credentialDir = join(fakeHome, ".agent-valley")
      const credentialPath = join(credentialDir, "credentials.json")
      const inactiveDir = join(fakeHome, ".codex")
      const inactiveCanary = join(inactiveDir, "synthetic-auth.json")
      try {
        mkdirSync(credentialDir, { recursive: true })
        mkdirSync(inactiveDir)
        writeFileSync(credentialPath, "synthetic-token-only")
        writeFileSync(inactiveCanary, "synthetic-inactive-token")
        const run = (command: string, args: string[]) => {
          const plan = buildDarwinSandboxCommand(
            { ...BASE_REQUEST, workspacePath: fakeHome, command, args, networkAllowlist: [] },
            "/usr/bin/sandbox-exec",
            fakeHome,
          )
          return spawnSync(plan.command, plan.args, { cwd: fakeHome, encoding: "utf8" })
        }
        expect(run("/bin/cat", [credentialPath]).status).not.toBe(0)
        expect(run("/usr/bin/touch", [credentialPath]).status).not.toBe(0)
        expect(run("/bin/cat", [inactiveCanary]).status).not.toBe(0)
        expect(run("/usr/bin/touch", [inactiveCanary]).status).not.toBe(0)
        expect(readFileSync(credentialPath, "utf8")).toBe("synthetic-token-only")
        expect(readFileSync(inactiveCanary, "utf8")).toBe("synthetic-inactive-token")
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    },
  )

  test("does not grant write access to a blanket ~/.config directory", () => {
    const result = buildDarwinSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "/usr/bin/sandbox-exec")
    const profile = result.args[1] as string
    expect(profile).not.toContain(`(allow file-write* (subpath "${homedir()}/.config"))`)
  })

  test("grants only the active agent's vendor directory", () => {
    const result = buildDarwinSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "/usr/bin/sandbox-exec")
    const profile = result.args[1] as string
    for (const dir of [".claude", ".cache", ".npm", ".bun"]) {
      expect(profile).toContain(`(allow file-write* (subpath "${homedir()}/${dir}"))`)
    }
    for (const dir of [".codex", ".cursor", ".grok", ".gemini", ".kimi-code"]) {
      expect(profile).toContain(`(deny file-read* (subpath "${homedir()}/${dir}"))`)
      expect(profile).not.toContain(`(allow file-write* (subpath "${homedir()}/${dir}"))`)
    }
    const antigravity = buildDarwinSandboxCommand({
      ...BASE_REQUEST,
      agentType: "antigravity",
      networkAllowlist: [],
    }).args[1] as string
    expect(antigravity).toContain(`(allow file-write* (subpath "${homedir()}/.gemini"))`)
    expect(antigravity).not.toContain(`(deny file-read* (subpath "${homedir()}/.gemini"))`)
    const opencode = buildDarwinSandboxCommand({
      ...BASE_REQUEST,
      agentType: "opencode",
      networkAllowlist: [],
    }).args[1] as string
    expect(opencode).toContain(`(allow file-write* (subpath "${homedir()}/.local/share/opencode"))`)
    expect(opencode).toContain(`(allow file-write* (subpath "${homedir()}/.config/opencode"))`)
    expect(opencode).toContain(`(deny file-read* (subpath "${homedir()}/.claude"))`)
  })

  test.skipIf(process.platform !== "darwin")("commits in a real linked worktree and denies sibling metadata", () => {
    withGitWorktrees(({ repo, first, second }) => {
      const gitPaths = linkedWorktreeGitPaths(first)
      const siblingPaths = linkedWorktreeGitPaths(second)
      expect(gitPaths).not.toBeNull()
      expect(siblingPaths).not.toBeNull()
      const run = (...command: string[]) => {
        const plan = buildDarwinSandboxCommand({
          ...BASE_REQUEST,
          workspacePath: first,
          command: command[0] as string,
          args: command.slice(1),
          networkAllowlist: [],
        })
        return spawnSync(plan.command, plan.args, {
          cwd: first,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        })
      }

      writeFileSync(join(first, "file.txt"), "changed\n")
      expect(run("git", "status", "--short").status).toBe(0)
      const add = run("git", "add", "file.txt")
      expect(add.status).toBe(0)
      const commit = run("git", "commit", "-qm", "change")
      expect(commit.stderr).not.toContain("packed-refs")
      expect(commit.status).toBe(0)
      expect(git(first, "show", "HEAD:file.txt")).toBe("changed")

      const siblingHead = git(second, "rev-parse", "HEAD")
      expect(run("git", "update-ref", "refs/heads/feature/TWO", git(first, "rev-parse", "HEAD")).status).not.toBe(0)
      expect(git(second, "rev-parse", "HEAD")).toBe(siblingHead)

      for (const forbidden of [
        join(siblingPaths?.gitDir as string, "index.lock"),
        `${siblingPaths?.branchRef}.lock`,
        join(repo, ".git", "config.lock"),
        join(repo, ".git", "objects", "info", "alternates"),
        join(repo, ".git", "objects", "pack", "forbidden.pack"),
      ]) {
        const denied = run("/usr/bin/touch", forbidden)
        expect(denied.status).not.toBe(0)
        expect(existsSync(forbidden)).toBe(false)
      }
      const infoDir = join(repo, ".git", "objects", "info")
      expect(existsSync(infoDir)).toBe(true)
      expect(run("/bin/mv", infoDir, `${infoDir}-moved`).status).not.toBe(0)
      expect(existsSync(infoDir)).toBe(true)
    })
  })

  test("does not grant Git metadata from a forged worktree pointer", () => {
    withGitWorktrees(({ first, second }) => {
      const sibling = linkedWorktreeGitPaths(second)
      expect(sibling).not.toBeNull()
      writeFileSync(join(first, ".git"), `gitdir: ${sibling?.gitDir}\n`)
      expect(linkedWorktreeGitPaths(first)).toBeNull()
      const profile = buildDarwinSandboxCommand({ ...BASE_REQUEST, workspacePath: first, networkAllowlist: [] }).args[1]
      expect(profile).not.toContain(sibling?.gitDir)
    })
  })
})

describe("buildLinuxSandboxCommand", () => {
  test("masks relay credentials after workspace binds", () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-mask-test-"))
    const fakeHome = join(fixture, "home")
    try {
      mkdirSync(fakeHome)
      const result = buildLinuxSandboxCommand(
        { ...BASE_REQUEST, workspacePath: fakeHome, networkAllowlist: [] },
        "bwrap",
        fakeHome,
      )
      const workspaceBind = result.args.findIndex((arg, i) => arg === "--bind-try" && result.args[i + 1] === fakeHome)
      const credentialMask = result.args.findIndex(
        (arg, i) => arg === "--tmpfs" && result.args[i + 1] === join(fakeHome, ".agent-valley"),
      )
      expect(workspaceBind).toBeGreaterThan(-1)
      expect(credentialMask).toBeGreaterThan(workspaceBind)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("rejects reused linked or broken worktrees on Linux without deleting issue files", async () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-reuse-test-"))
    const repo = join(fixture, "repo")
    try {
      mkdirSync(repo)
      git(repo, "init", "-qb", "main")
      writeFileSync(join(repo, "file.txt"), "base\n")
      git(repo, "add", "file.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
      const issue = {
        id: "reuse",
        identifier: "REUSE-1",
        title: "feat: reuse",
        description: "",
        status: { id: "todo", name: "Todo", type: "unstarted" },
        team: { id: "team", key: "REUSE" },
        labels: [],
        url: "",
        score: null,
        parentId: null,
        children: [],
        relations: [],
      } satisfies Issue
      const workspace = await createWorkspace(repo, issue, "darwin")
      const issueFile = join(workspace.path, "pending.txt")
      writeFileSync(issueFile, "keep this work")
      await expect(createWorkspace(repo, issue, "linux")).rejects.toThrow(/linked or broken Git worktree/)
      expect(readFileSync(issueFile, "utf8")).toBe("keep this work")
      rmSync(join(workspace.path, ".git"))
      await expect(createWorkspace(repo, issue, "linux")).rejects.toThrow(/linked or broken Git worktree/)
      expect(readFileSync(issueFile, "utf8")).toBe("keep this work")
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("replays Linux retry commits onto a rebased imported branch without losing source changes", async () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-retry-test-"))
    const repo = join(fixture, "repo")
    try {
      mkdirSync(repo)
      git(repo, "init", "-qb", "main")
      writeFileSync(join(repo, "base.txt"), "base\n")
      git(repo, "add", "base.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
      const issue = {
        id: "retry",
        identifier: "RETRY-1",
        title: "feat: retry",
        description: "",
        status: { id: "todo", name: "Todo", type: "unstarted" },
        team: { id: "team", key: "RETRY" },
        labels: [],
        url: "",
        score: null,
        parentId: null,
        children: [],
        relations: [],
      } satisfies Issue
      const workspace = await createWorkspace(repo, issue, "linux")
      writeFileSync(join(workspace.path, "feature.txt"), "original change\n")
      git(workspace.path, "add", "feature.txt")
      git(workspace.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "feature")
      expect((await pushBranch(workspace, repo)).ok).toBe(true)

      writeFileSync(join(repo, "main.txt"), "new main change\n")
      git(repo, "add", "main.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "main advance")
      git(repo, "rebase", "main", workspace.branch)
      git(repo, "checkout", "-q", "main")

      writeFileSync(join(workspace.path, "retry.txt"), "retry change\n")
      git(workspace.path, "add", "retry.txt")
      git(workspace.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "retry")
      expect((await pushBranch(workspace, repo)).ok).toBe(true)
      expect(git(repo, "show", `${workspace.branch}:feature.txt`)).toBe("original change")
      expect(git(repo, "show", `${workspace.branch}:main.txt`)).toBe("new main change")
      expect(git(repo, "show", `${workspace.branch}:retry.txt`)).toBe("retry change")
      expect(git(workspace.path, "show", "HEAD:retry.txt")).toBe("retry change")
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
  test("rejects a linked worktree because its shared refs cannot be bound individually", () => {
    withGitWorktrees(({ first }) => {
      expect(() => buildLinuxSandboxCommand({ ...BASE_REQUEST, workspacePath: first, networkAllowlist: [] })).toThrow(
        /isolated Git clone/,
      )
    })
  })

  test("creates an isolated Linux workspace from a non-main default branch", async () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-trunk-test-"))
    const repo = join(fixture, "repo")
    try {
      mkdirSync(repo)
      git(repo, "init", "-qb", "trunk")
      writeFileSync(join(repo, "file.txt"), "base\n")
      git(repo, "add", "file.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
      const issue = { id: "trunk", identifier: "TRUNK-1", title: "feat: trunk" } as Issue
      const workspace = await createWorkspace(repo, issue, "linux")
      expect(git(workspace.path, "show", "HEAD:file.txt")).toBe("base")
      expect(git(workspace.path, "branch", "--show-current")).toBe(workspace.branch)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("creates an isolated Linux workspace with private Git metadata and no parent bind", async () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-test-"))
    const repo = join(fixture, "repo")
    try {
      mkdirSync(repo)
      git(repo, "init", "-qb", "main")
      writeFileSync(join(repo, "file.txt"), "base\n")
      git(repo, "add", "file.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
      const issue = {
        id: "one",
        identifier: "ONE-1",
        title: "feat: isolated metadata",
        description: "",
        status: { id: "todo", name: "Todo", type: "unstarted" },
        team: { id: "team", key: "ONE" },
        labels: [],
        url: "",
        score: null,
        parentId: null,
        children: [],
        relations: [],
      } satisfies Issue
      const workspace = await createWorkspace(repo, issue, "linux")
      expect(existsSync(join(workspace.path, ".git", "HEAD"))).toBe(true)
      expect(linkedWorktreeGitPaths(workspace.path)).toBeNull()
      writeFileSync(join(workspace.path, "file.txt"), "changed\n")
      git(workspace.path, "add", "file.txt")
      git(workspace.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "change")
      expect(git(workspace.path, "show", "HEAD:file.txt")).toBe("changed")
      expect(git(workspace.path, "remote")).toBe("")
      expect((await detectUnfinishedWork(workspace)).hasCodeChanges).toBe(true)
      expect(await getDiffStat(workspace)).toContain("1 file changed")

      const plan = buildLinuxSandboxCommand({ ...BASE_REQUEST, workspacePath: workspace.path, networkAllowlist: [] })
      const boundTargets = plan.args.flatMap((arg, i) => (arg === "--bind-try" ? [plan.args[i + 1]] : []))
      expect(boundTargets).toContain(workspace.path)
      expect(boundTargets).not.toContain(join(repo, ".git"))

      expect(await pushBranch(workspace, repo)).toEqual({ ok: true })
      expect(git(repo, "show", `${workspace.branch}:file.txt`)).toBe("changed")
      expect((await mergeAndPush(workspace, repo)).ok).toBe(true)
      expect(git(repo, "show", "main:file.txt")).toBe("changed")
      await cleanupWorkspace(workspace, repo)
      expect(existsSync(workspace.path)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("delivers an isolated Linux branch to a local origin", async () => {
    const fixture = mkdtempSync(join(process.cwd(), ".sandbox-linux-delivery-test-"))
    const repo = join(fixture, "repo")
    const origin = join(fixture, "origin.git")
    try {
      mkdirSync(repo)
      mkdirSync(origin)
      git(repo, "init", "-qb", "main")
      git(origin, "init", "--bare", "-q")
      writeFileSync(join(repo, "file.txt"), "base\n")
      git(repo, "add", "file.txt")
      git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
      git(repo, "remote", "add", "origin", origin)
      git(repo, "push", "-q", "origin", "main")
      const issue = {
        id: "delivery",
        identifier: "DEL-1",
        title: "feat: isolated delivery",
        description: "",
        status: { id: "todo", name: "Todo", type: "unstarted" },
        team: { id: "team", key: "DEL" },
        labels: [],
        url: "",
        score: null,
        parentId: null,
        children: [],
        relations: [],
      } satisfies Issue
      const workspace = await createWorkspace(repo, issue, "linux")
      expect(git(workspace.path, "remote", "get-url", "origin")).toBe(origin)
      writeFileSync(join(workspace.path, "file.txt"), "delivered\n")
      git(workspace.path, "add", "file.txt")
      git(workspace.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "delivery")

      expect((await pushBranch(workspace, repo)).ok).toBe(true)
      expect(git(origin, "show", `${workspace.branch}:file.txt`)).toBe("delivered")
      expect((await mergeAndPush(workspace, repo)).ok).toBe(true)
      expect(git(origin, "show", "main:file.txt")).toBe("delivered")
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("binds the workspace read-write and appends the base command at the tail", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    expect(result.command).toBe("bwrap")
    expect(result.args).toContain("--bind-try")
    const wsIndex = result.args.indexOf(BASE_REQUEST.workspacePath)
    expect(wsIndex).toBeGreaterThan(-1)
    expect(result.args[wsIndex - 1]).toBe("--bind-try")
    // Original command + args are appended after a bare "--" separator.
    const sepIndex = result.args.indexOf("--")
    expect(sepIndex).toBeGreaterThan(-1)
    expect(result.args.slice(sepIndex + 1)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("only ro-binds root directories that actually exist on this host", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const roBindTargets = result.args.filter(
      (_, i) => result.args[i - 1] === "--ro-bind" && result.args[i - 2] !== "--ro-bind",
    )
    for (const target of roBindTargets) {
      if (typeof target === "string" && target.startsWith("/")) {
        expect(existsSync(target)).toBe(true)
      }
    }
  })

  test("masks ~/.config/agent-valley and ~/.ssh with --tmpfs after the read-only $HOME bind", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const home = homedir()
    const homeRoBindIndex = result.args.indexOf("--ro-bind")
    const agentValleyConfig = `${home}/.config/agent-valley`
    const sshDir = `${home}/.ssh`

    const tmpfsIndex = result.args.indexOf("--tmpfs")
    expect(tmpfsIndex).toBeGreaterThan(-1)
    expect(tmpfsIndex).toBeGreaterThan(homeRoBindIndex)
    expect(result.args).toContain(agentValleyConfig)
    expect(result.args).toContain(sshDir)
    expect(result.args[result.args.indexOf(agentValleyConfig) - 1]).toBe("--tmpfs")
    expect(result.args[result.args.indexOf(sshDir) - 1]).toBe("--tmpfs")
  })

  test("masks ~/.git-credentials by ro-binding /dev/null over it", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const gitCredentials = `${homedir()}/.git-credentials`
    const idx = result.args.indexOf(gitCredentials)
    expect(idx).toBeGreaterThan(-1)
    expect(result.args[idx - 1]).toBe("/dev/null")
    expect(result.args[idx - 2]).toBe("--ro-bind")
  })

  test("does not bind-try a blanket ~/.config directory read-write", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const bareConfig = `${homedir()}/.config`
    // The directory string must not appear immediately after --bind-try —
    // masked/curated subpaths like .config/agent-valley are fine, the
    // bare `.config` blanket entry is not.
    const bindTryIndices = result.args.reduce<number[]>((acc, arg, i) => {
      if (arg === "--bind-try") acc.push(i)
      return acc
    }, [])
    const boundTargets = bindTryIndices.map((i) => result.args[i + 1])
    expect(boundTargets).not.toContain(bareConfig)
  })

  test("binds only the active agent's vendor directory and masks inactive ones", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const home = homedir()
    for (const dir of [".claude", ".cache", ".npm", ".bun"]) {
      const target = `${home}/${dir}`
      const idx = result.args.indexOf(target)
      expect(idx).toBeGreaterThan(-1)
      expect(result.args[idx - 1]).toBe("--bind-try")
    }
    for (const dir of [".codex", ".cursor", ".grok", ".gemini", ".kimi-code"]) {
      const target = `${home}/${dir}`
      const idx = result.args.indexOf(target)
      expect(idx).toBeGreaterThan(-1)
      expect(result.args[idx - 1]).toBe("--tmpfs")
    }
    const antigravity = buildLinuxSandboxCommand(
      { ...BASE_REQUEST, agentType: "antigravity", networkAllowlist: [] },
      "bwrap",
    )
    const geminiIndex = antigravity.args.indexOf(`${home}/.gemini`)
    expect(antigravity.args[geminiIndex - 1]).toBe("--bind-try")
  })

  test("workspace path stays read-write via --bind-try regardless of the credential mask", () => {
    const result = buildLinuxSandboxCommand({ ...BASE_REQUEST, networkAllowlist: [] }, "bwrap")
    const idx = result.args.indexOf(BASE_REQUEST.workspacePath)
    expect(idx).toBeGreaterThan(-1)
    expect(result.args[idx - 1]).toBe("--bind-try")
  })
})

describe("planSandboxedSpawn", () => {
  beforeEach(() => {
    resetSandboxExecCache()
    resetBwrapCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("darwin + sandbox available: wraps the spawn and reports sandboxed=true", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "darwin",
      env: {},
      checkAvailable: async () => true,
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.platform).toBe("darwin")
    expect(plan.command).toBe("/usr/bin/sandbox-exec")
    expect(plan.args.slice(-BASE_REQUEST.args.length - 1)).toEqual([BASE_REQUEST.command, ...BASE_REQUEST.args])
  })

  test("linux + sandbox available: wraps via bwrap and warns about the network gap", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "linux",
      env: {},
      checkAvailable: async () => true,
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.command).toBe("bwrap")
    expect(warnSpy).toHaveBeenCalledWith(
      "sessions.sandbox",
      expect.stringContaining("network egress is NOT domain-restricted"),
      expect.objectContaining({ agentType: "claude" }),
    )
  })

  test("darwin + no sandbox binary + no opt-in: fails closed with an actionable error", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "darwin",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/sandbox-exec/)
  })

  test("fail-closed error names the opt-in env var and the fix", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "linux",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(new RegExp(`bwrap.*${ALLOW_UNSANDBOXED_ENV_VAR}=1`, "s"))
  })

  test("unsupported platform + no opt-in: fails closed and names the platform", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "win32",
        env: {},
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/win32/)
  })

  test("opt-in gate: SYMPHONY_ALLOW_UNSANDBOXED=1 allows a loud, unsandboxed fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "linux",
      env: { [ALLOW_UNSANDBOXED_ENV_VAR]: "1" },
      checkAvailable: async () => false,
    })
    expect(plan.sandboxed).toBe(false)
    expect(plan.command).toBe(BASE_REQUEST.command)
    expect(plan.args).toEqual(BASE_REQUEST.args)
    expect(warnSpy).toHaveBeenCalledWith(
      "sessions.sandbox",
      expect.stringContaining("WITHOUT an OS sandbox"),
      expect.objectContaining({ agentType: "claude", platform: "linux" }),
    )
  })

  test("opt-in gate rejects any value other than '1'", async () => {
    await expect(
      planSandboxedSpawn(BASE_REQUEST, {
        platform: "darwin",
        env: { [ALLOW_UNSANDBOXED_ENV_VAR]: "yes" },
        checkAvailable: async () => false,
      }),
    ).rejects.toThrow(/sandbox-exec/)
  })

  test("network allowlist passed through the plan reflects env overrides", async () => {
    const plan = await planSandboxedSpawn(BASE_REQUEST, {
      platform: "darwin",
      env: { [NETWORK_ALLOWLIST_ENV_VAR]: "custom.example.com" },
      checkAvailable: async () => true,
    })
    expect(plan.networkAllowlist).toContain("custom.example.com")
    expect(plan.networkAllowlist).toContain("api.anthropic.com")
  })
})
