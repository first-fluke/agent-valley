import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { planPrePush } from "./pre-push.mjs"

const script = fileURLToPath(new URL("./pre-push.mjs", import.meta.url))
const projects = ["packages/core/tsconfig.json", "apps/cli/tsconfig.json", "apps/dashboard/tsconfig.json"]
let root: string
let calls: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-pre-push-")))
  calls = join(root, "calls.jsonl")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function installCheckers() {
  const directory = join(root, "node_modules", ".bin")
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  const checker = `
    import { appendFileSync } from "node:fs";
    import { basename } from "node:path";
    import { execFileSync } from "node:child_process";
    const tool = basename(process.argv[1]);
    appendFileSync(process.env.CHECK_CALLS, JSON.stringify({
      tool, args: process.argv.slice(2), changedOnly: process.env.AV_CHANGED_PRE_PUSH,
      git: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"))),
      fixtureRoot: process.env.GIT_FIXTURE ? execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd: process.env.GIT_FIXTURE, encoding: "utf8"}).trim() : undefined,
    }) + "\\n");
    if (process.env.FAIL_TOOL === tool) process.exit(Number(process.env.FAIL_CODE));
  `
  await Promise.all(["vitest", "tsc"].map((tool) => writeFile(join(directory, tool), checker)))
}

function push(files: string[], env: NodeJS.ProcessEnv = {}, explicit = true, input = "") {
  return spawnSync(process.execPath, [script, ...(explicit ? ["--files"] : []), ...files], {
    cwd: root,
    env: { ...process.env, CHECK_CALLS: calls, ...env },
    encoding: "utf8",
    input,
    timeout: 15_000,
  })
}

async function recorded(): Promise<
  Array<{ tool: string; args: string[]; git: Record<string, string>; fixtureRoot?: string }>
> {
  return (await readFile(calls, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  }).trim()
}
function commit() {
  git("add", ".")
  git("-c", "user.name=Hook fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture")
  return git("rev-parse", "HEAD")
}
async function repository() {
  await installCheckers()
  git("init", "--quiet", "--initial-branch=main")
  await writeFile(join(root, ".gitignore"), "node_modules/\ncalls.jsonl\n")
  await mkdir(join(root, "apps", "cli", "src"), { recursive: true })
  for (const name of ["deleted", "staged", "unstaged"])
    await writeFile(join(root, "apps", "cli", "src", `${name}.ts`), "export const value = 1\n")
  return commit()
}

describe("changed-input pre-push checks", () => {
  it.each([
    { files: [] },
    { files: ["README.md", "docs/guides/chief-missions.md", ".agents/skills/oma-debug/SKILL.md"] },
  ])("runs no checker or dependency installation for no changed code: %j", async ({ files }) => {
    expect(planPrePush(files, root)).toEqual([])
    const result = push(files)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("no changed code inputs")
    expect(await recorded()).toEqual([])
  })

  it.each([
    ["packages/core/src/chief/routing.ts", projects],
    ["apps/cli/src/index.ts", [projects[1]]],
    ["apps/dashboard/src/app/page.tsx", [projects[2]]],
  ] as const)("selects related tests and whole affected projects for %s", async (file, expected) => {
    await installCheckers()
    const result = push([file, "README.md", file])
    expect(result.status, result.stderr).toBe(0)
    const commands = await recorded()
    expect(commands[0]).toMatchObject({
      tool: "vitest",
      args: ["related", "--run", "--config", "vitest.config.ts", "--passWithNoTests", resolve(root, file)],
    })
    expect(commands.slice(1).map((command) => command.args.at(-1))).toEqual(expected)
    expect(commands.slice(1).every((command) => command.tool === "tsc" && command.args.includes("--noEmit"))).toBe(true)
    const dashboard = commands.find((command) => command.args.at(-1) === projects[2])
    if (dashboard) expect(dashboard.args).toContain("--incremental")
  })

  it("keeps shared dependency and TypeScript changes scoped to related tests while checking all affected apps", async () => {
    await installCheckers()
    const files = ["package.json", "bun.lock", "tsconfig.json"]
    expect(push(files).status).toBe(0)
    const commands = await recorded()
    expect(commands[0]?.args.slice(5)).toEqual(files.map((file) => resolve(root, file)))
    expect(commands.slice(1).map((command) => command.args.at(-1))).toEqual(projects)
    expect(commands.filter((command) => command.tool === "vitest")).toHaveLength(1)
    expect(commands[0]?.args[0]).toBe("related")
    expect(commands[0]).toMatchObject({ changedOnly: "1" })
  })

  it("does not typecheck apps for hook configuration and root scripts", async () => {
    await installCheckers()
    expect(push(["scripts/pre-push.mjs", "hk.pkl"]).status).toBe(0)
    expect((await recorded()).map((command) => command.tool)).toEqual(["vitest"])
  })

  it("preserves exact spaces, globs, Unicode, newlines and option-like filenames without shell expansion", async () => {
    await installCheckers()
    const files = [
      "apps/cli/src/space [*] $(touch injected).ts",
      "apps/cli/src/한글.ts",
      "apps/cli/src/new\nline.ts",
      "--coverage.ts",
    ]
    expect(push(files).status).toBe(0)
    expect((await recorded())[0]?.args.slice(5)).toEqual(files.map((file) => resolve(root, file)))
    await expect(readFile(join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["vitest", "tsc"])("propagates %s failures without falling back to the full suite", async (tool) => {
    await installCheckers()
    const result = push(["packages/core/src/chief/routing.ts"], { FAIL_TOOL: tool, FAIL_CODE: "23" })
    expect(result.status).toBe(23)
    const commands = await recorded()
    expect(commands).toHaveLength(tool === "vitest" ? 1 : 2)
    expect(commands[0]?.args[0]).toBe("related")
    expect(commands.some((command) => command.args[0] === "run" || command.args.includes("--coverage"))).toBe(false)
  })

  it("fails with install instructions when a required local checker is missing", async () => {
    const result = push(["apps/cli/src/index.ts"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Local vitest is unavailable")
    expect(result.stderr).toContain("bun install --frozen-lockfile")
    expect(await recorded()).toEqual([])
  })

  it("rejects missing scope and escaping paths instead of guessing the whole project", async () => {
    expect(push([], {}, false).status).toBe(1)
    const result = push(["../outside.ts"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("escapes the repository")
    expect(await recorded()).toEqual([])
  })

  it("unions every outgoing ref with deletions, staged, unstaged and exact NUL-delimited untracked paths", async () => {
    const base = await repository()
    await writeFile(join(root, "README.md"), "Documentation change")
    const docs = commit()
    const published = "apps/cli/src/published-before-docs.ts"
    await writeFile(join(root, published), "export const published = true\n")
    commit()
    await writeFile(join(root, "README.md"), "Later documentation change")
    const head = commit()
    await rm(join(root, "apps/cli/src/deleted.ts"))
    await writeFile(join(root, "apps/cli/src/staged.ts"), "export const value = 2\n")
    git("add", "apps/cli/src/staged.ts")
    await writeFile(join(root, "apps/cli/src/unstaged.ts"), "export const value = 3\n")
    const untracked = "apps/cli/src/space [*]\n한글.ts"
    await writeFile(join(root, untracked), "export const untracked = true\n")
    const input = `refs/heads/docs ${docs} refs/heads/docs ${base}\nrefs/heads/main ${head} refs/heads/main ${docs}\n`
    const result = push(["README.md"], {}, true, input)
    expect(result.status, result.stderr).toBe(0)
    const commands = await recorded()
    expect(new Set(commands[0]?.args.slice(5))).toEqual(
      new Set(
        [published, "apps/cli/src/deleted.ts", "apps/cli/src/staged.ts", "apps/cli/src/unstaged.ts", untracked].map(
          (file) => resolve(root, file),
        ),
      ),
    )
    expect(commands.slice(1).map((command) => command.args.at(-1))).toEqual([projects[1]])
  })

  it("uses a known remote default merge base for a new branch without testing unrelated files", async () => {
    const base = await repository()
    git("update-ref", "refs/remotes/origin/main", base)
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    const file = "apps/cli/src/feature.ts"
    await writeFile(join(root, file), "export const feature = true\n")
    const head = commit()
    const result = push([], {}, true, `refs/heads/main ${head} refs/heads/new-feature ${"0".repeat(40)}\n`)
    expect(result.status, result.stderr).toBe(0)
    expect((await recorded())[0]?.args.slice(5)).toEqual([resolve(root, file)])
  })

  it.each(["0", "f"])("fails closed for an unestablished %s push base instead of running all tests", async (digit) => {
    const head = await repository()
    const result = push([], {}, true, `refs/heads/main ${head} refs/heads/main ${digit.repeat(40)}\n`)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Fetch|fetch/)
    expect(await recorded()).toEqual([])
  })

  it("removes Git's repository-local environment before a checker creates or uses another Git fixture", async () => {
    await installCheckers()
    const fixture = join(root, "independent-repository")
    await mkdir(fixture)
    for (const cwd of [root, fixture]) execFileSync("git", ["init", "--quiet"], { cwd })
    const result = push(["apps/cli/src/index.ts"], {
      GIT_DIR: join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, ".git", "index"),
      GIT_PREFIX: "source/",
      GIT_FIXTURE: fixture,
    })
    expect(result.status, result.stderr).toBe(0)
    for (const command of await recorded()) {
      expect(command.git.GIT_DIR).toBeUndefined()
      expect(command.git.GIT_WORK_TREE).toBeUndefined()
      expect(command.git.GIT_INDEX_FILE).toBeUndefined()
      expect(command.git.GIT_PREFIX).toBeUndefined()
      expect(command.fixtureRoot).toBe(fixture)
    }
  })
})
