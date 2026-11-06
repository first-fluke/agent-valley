import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const projects = ["packages/core/tsconfig.json", "apps/cli/tsconfig.json", "apps/dashboard/tsconfig.json"]
const shared = /^(?:package\.json|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json)$/
const executableInput = /\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html|sh|py|rs|pkl)$/i

/** HK supplies each changed path as an argv entry, including the outgoing push range. */
export function planPrePush(files, repository = process.cwd()) {
  const root = resolve(repository)
  const inputs = [
    ...new Set(
      files.map((file) => {
        if (typeof file !== "string" || !file || file.includes("\0"))
          throw new Error(
            "Pass each changed file as one argument after --files; do not combine a NUL-delimited list into argv.",
          )
        const path = relative(root, resolve(root, file))
        if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
          throw new Error(`Changed path escapes the repository: ${file}. Run the hook from the repository root.`)
        return path.split(sep).join("/")
      }),
    ),
  ].filter(
    (path) => !path.startsWith("docs/") && (executableInput.test(path) || path === "bun.lock" || path === "bun.lockb"),
  )
  if (!inputs.length) return []
  const affected = new Set()
  for (const path of inputs) {
    if (shared.test(path) || path.startsWith("packages/core/")) {
      for (const project of projects) affected.add(project)
    } else if (path.startsWith("apps/cli/")) affected.add(projects[1])
    else if (path.startsWith("apps/dashboard/")) affected.add(projects[2])
  }
  return [
    {
      tool: "vitest",
      args: [
        "related",
        "--run",
        "--config",
        "vitest.config.ts",
        "--passWithNoTests",
        ...inputs.map((path) => resolve(root, path)),
      ],
    },
    ...projects
      .filter((project) => affected.has(project))
      .map((project) => ({
        tool: "tsc",
        args: ["--noEmit", ...(project === projects[2] ? ["--incremental", "false"] : []), "-p", project],
      })),
  ]
}

function childEnvironment(repository, env) {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], { cwd: repository, env, encoding: "utf8" })
  if (result.error || result.status !== 0)
    throw new Error(
      "Could not inspect Git's repository-local environment. Restore the local git command before retrying pre-push.",
    )
  const clean = { ...env }
  for (const name of result.stdout.trim().split(/\r?\n/)) delete clean[name]
  return clean
}

/** Native HK selection omits deletions and some ref updates; raw Git stdin supplies those exact bases. */
export function pushChangedFiles(repository, input, env = process.env) {
  const git = (args, optional = false) => {
    const result = spawnSync("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
      cwd: repository,
      env,
      encoding: "utf8",
    })
    if (result.error || result.status !== 0) {
      if (optional) return undefined
      throw new Error(
        "Could not determine the outgoing Git change scope. Fetch the missing push base and retry; pre-push will not fall back to all tests.",
      )
    }
    return result.stdout
  }
  const paths = []
  const diff = ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"]
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
  for (const line of input.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4 || !oid.test(fields[1]) || !oid.test(fields[3]))
      throw new Error(
        "Invalid pre-push ref input. Let hk forward Git's original hook_stdin; do not substitute a filename list.",
      )
    const [localRef, local, , remote] = fields
    if (/^0+$/.test(local)) continue
    git(["rev-parse", "--verify", `${local}^{commit}`])
    let base = remote
    if (/^0+$/.test(base)) {
      let upstream = git(["rev-parse", "--verify", `${localRef}@{upstream}^{commit}`], true)?.trim()
      if (!upstream) {
        const heads = git(["for-each-ref", "--format=%(refname)", "refs/remotes"])
          .trim()
          .split("\n")
          .filter((ref) => ref.endsWith("/HEAD"))
        if (heads.length === 1) upstream = git(["rev-parse", "--verify", `${heads[0]}^{commit}`], true)?.trim()
      }
      if (!upstream)
        throw new Error(
          "The new branch has no known push base. Fetch the remote default branch and establish its remote HEAD or upstream before retrying; pre-push will not guess the entire repository.",
        )
      base = git(["merge-base", upstream, local]).trim()
    }
    git(["rev-parse", "--verify", `${base}^{commit}`])
    paths.push(
      ...git([...diff, base, local, "--"])
        .split("\0")
        .filter(Boolean),
    )
  }
  for (const args of [
    [...diff, "--cached", "--"],
    [...diff, "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ])
    paths.push(...git(args).split("\0").filter(Boolean))
  return paths
}

/** Run only locally installed checkers; this hook never fetches packages or expands shell globs. */
export function runPrePush(files, repository = process.cwd(), env = process.env, hookStdin = "") {
  const root = resolve(repository)
  // HK can fall back to the entire tree when a remote-tracking ref is missing.
  const changed = hookStdin.trim() ? pushChangedFiles(root, hookStdin, env) : files
  const plan = planPrePush(changed, root)
  if (!plan.length) {
    console.log("pre-push: no changed code inputs; tests and type checks skipped.")
    return 0
  }
  const binaries = new Map()
  for (const { tool } of plan) {
    const path = resolve(root, "node_modules", ".bin", tool)
    try {
      if (!statSync(path).isFile()) throw new Error("Not a file")
      accessSync(path, constants.R_OK)
    } catch {
      throw new Error(
        `Local ${tool} is unavailable at ${path}. Run bun install --frozen-lockfile before retrying the push; hooks do not download packages.`,
      )
    }
    binaries.set(tool, path)
  }
  const clean = { ...childEnvironment(root, env), AV_CHANGED_PRE_PUSH: "1" }
  // Hooks run under Bun; Vitest and tsc keep their usual Node runtime semantics.
  const runtime = process.versions.bun ? "node" : process.execPath
  for (const step of plan) {
    console.log(
      `pre-push: ${step.tool === "vitest" ? "tests related to changed inputs" : `typecheck ${step.args.at(-1)}`}`,
    )
    const result = spawnSync(runtime, [binaries.get(step.tool), ...step.args], {
      cwd: root,
      env: clean,
      stdio: "inherit",
    })
    if (result.error)
      throw new Error(
        `Could not run local ${step.tool} with Node: ${result.error.message}. Restore the project's pinned Node runtime with mise and retry the push.`,
      )
    if (result.status !== 0) {
      if (result.signal)
        console.error(`pre-push: ${step.tool} terminated by ${result.signal}; validation did not pass.`)
      return result.status ?? 1
    }
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "--files")
      throw new Error(
        "Usage: bun scripts/pre-push.mjs --files [changed-file ...]. Let hk provide the push-range file list.",
      )
    process.exitCode = runPrePush(
      process.argv.slice(3),
      process.cwd(),
      process.env,
      process.stdin.isTTY ? "" : readFileSync(0, "utf8"),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
