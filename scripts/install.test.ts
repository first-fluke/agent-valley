import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"

let root: string
let source: string
let target: string
let bin: string
let home: string
let log: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "av-install-")))
  source = join(root, "source with spaces")
  target = join(root, "target with spaces")
  home = join(root, "home with spaces")
  bin = join(root, "fake bin")
  log = join(root, "commands.log")
  for (const path of ["scripts/harness", ".agents", "apps/cli/src"]) mkdirSync(join(source, path), { recursive: true })
  mkdirSync(target)
  mkdirSync(home)
  mkdirSync(bin)
  cpSync(resolve("scripts/install.sh"), join(source, "scripts/install.sh"))
  cpSync(resolve("scripts/install-cli.sh"), join(source, "scripts/install-cli.sh"))
  for (const name of ["gc.sh", "validate.sh"])
    writeFileSync(join(source, "scripts/harness", name), "#!/bin/sh\nexit 0\n")
  writeFileSync(join(source, "AGENTS.md"), "Source instructions\n")
  writeFileSync(join(source, ".gitignore"), "dist/\nav.yaml\n")
  writeFileSync(join(source, "av.example.yaml"), "actor:\n  type: codex\n")
  writeFileSync(join(source, "package.json"), JSON.stringify({ packageManager: "bun@1.4.2" }))
  writeFileSync(join(source, ".node-version"), "26.10.0\n")
  writeFileSync(join(source, "bun.lock"), "fixture lock\n")
  writeFileSync(join(source, "apps/cli/src/index.ts"), "// Fixture CLI source\n")
  writeFileSync(join(target, "package.json"), "{}")
  executable("node", 'printf "%s\\n" "${AV_TEST_NODE_VERSION:-v26.10.0}"')
  executable(
    "bun",
    `
if [[ "$1" == --version ]]; then echo 1.4.2; exit 0; fi
printf 'cwd=%s\\n' "$PWD" >> "$AV_TEST_LOG"
printf 'arg=%s\\n' "$@" >> "$AV_TEST_LOG"
if [[ "$1" == run ]]; then
  if [[ "\${3:-}" == integrations && "\${AV_TEST_INTEGRATIONS_FAIL:-}" == true ]]; then
    echo 'Fixture AV skill conflict: preserve existing files' >&2
    exit 7
  fi
  if [[ -t 0 ]]; then echo stdin=tty >> "$AV_TEST_LOG"; else echo stdin=pipe >> "$AV_TEST_LOG"; fi
  if [[ -n "\${AV_TEST_RESOLVE_AGENT:-}" ]]; then
    printf 'agent=%s\\n' "$(command -v "$AV_TEST_RESOLVE_AGENT")" >> "$AV_TEST_LOG"
  fi
fi
`,
  )
  executable(
    "git",
    `
if [[ "$1" == clone ]]; then
  destination="\${!#}"
  mkdir -p "$destination"
  cp -R "$AV_TEST_SOURCE/." "$destination/"
  mkdir -p "$destination/.git"
elif [[ "$1" == -C && "$3" == remote ]]; then
  echo https://github.com/first-fluke/agent-valley.git
elif [[ "$1" == -C && "$3" == pull ]]; then
  echo git=pull >> "$AV_TEST_LOG"
elif [[ "$1" != -C || "$3" != status ]]; then
  echo Unexpected git call >&2; exit 1
fi
`,
  )
  env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    CI: "",
    XDG_DATA_HOME: join(home, ".local/share"),
    AGENT_VALLEY_BIN_DIR: join(home, ".local/bin"),
    AGENT_VALLEY_INSTALL_DIR: join(home, ".local/share/agent-valley"),
    AV_TEST_LOG: log,
    AV_TEST_SOURCE: source,
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function executable(name: string, body: string) {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`)
  chmodSync(path, 0o755)
}

function install(cwd: string, args = ["--yes", "--no-workflows"]) {
  return spawnSync("bash", [join(source, "scripts/install.sh"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  })
}

test("running inside a clone leaves its existing instructions intact", () => {
  const result = install(source)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("setup --mode order")
  expect(readFileSync(log, "utf8")).toContain("arg=--frozen-lockfile")
  expect(readFileSync(log, "utf8")).toContain("arg=--ignore-scripts")
  expect(readFileSync(log, "utf8")).not.toContain("arg=setup")
  expect(readFileSync(join(source, "AGENTS.md"), "utf8")).toBe("Source instructions\n")
})

test("repeated install preserves existing instructions and deduplicates exact ignore entries", () => {
  writeFileSync(join(target, "AGENTS.md"), "Project-specific instructions\n")
  writeFileSync(join(target, ".gitignore"), "other-dist/\n")
  writeFileSync(join(target, "av.yaml"), "canonical project configuration\n")
  writeFileSync(join(target, "valley.yaml"), "custom project configuration\n")
  mkdirSync(join(home, ".config/agent-valley"), { recursive: true })
  writeFileSync(join(home, ".config/agent-valley/settings.yaml"), "custom global configuration\n")
  expect(install(target).status).toBe(0)
  const result = install(target)
  expect(result.status).toBe(0)
  const instructions = readFileSync(join(target, "AGENTS.md"), "utf8")
  expect(instructions).toContain("Project-specific instructions")
  expect(instructions.match(/## Symphony Harness/g)).toHaveLength(1)
  const ignores = readFileSync(join(target, ".gitignore"), "utf8").split("\n")
  expect(ignores.filter((line) => line === "dist/")).toHaveLength(1)
  expect(ignores.filter((line) => line === "av.yaml")).toHaveLength(1)
  expect(ignores).not.toContain("valley.yaml")
  expect(result.stdout).toContain("Installed av")
  expect(readFileSync(join(target, "av.example.yaml"), "utf8")).toContain("actor:")
  expect(readFileSync(join(target, "av.yaml"), "utf8")).toBe("canonical project configuration\n")
  expect(readFileSync(join(target, "valley.yaml"), "utf8")).toBe("custom project configuration\n")
  expect(readFileSync(join(home, ".config/agent-valley/settings.yaml"), "utf8")).toBe("custom global configuration\n")
})

test("installed av handles spaced source paths and preserves the caller's repository and arguments", () => {
  expect(install(target).status).toBe(0)
  const result = spawnSync(
    join(home, ".local/bin/av"),
    ["order", "Goal with spaces", "--verify", "test -s report.md"],
    {
      cwd: target,
      env,
      encoding: "utf8",
      timeout: 5_000,
    },
  )
  expect(result.status).toBe(0)
  const calls = readFileSync(log, "utf8")
  expect(calls).toContain(`cwd=${target}`)
  expect(calls).toContain(`arg=${source}/apps/cli/src/index.ts`)
  expect(calls).toContain("arg=Goal with spaces\narg=--verify\narg=test -s report.md")
})

test("installer prepares project integrations after locked dependencies even when setup is deferred", () => {
  const result = install(target, ["--yes", "--no-workflows", "--no-setup"])
  expect(result.status).toBe(0)
  const calls = readFileSync(log, "utf8")
  expect(calls).toContain(
    `cwd=${target}\narg=run\narg=${source}/apps/cli/src/index.ts\narg=integrations\narg=install\narg=--workspace\narg=${target}`,
  )
  expect(calls.indexOf("arg=--ignore-scripts")).toBeLessThan(calls.indexOf("arg=integrations"))
  expect(calls).not.toContain("arg=setup")
})

test("an integration conflict reports the installed launcher and incomplete project setup honestly", () => {
  env.AV_TEST_INTEGRATIONS_FAIL = "true"
  const result = install(target)
  expect(result.status).toBe(1)
  expect(result.stdout).toContain("Installed av")
  expect(result.stderr).toContain("project client integrations are incomplete")
  expect(result.stderr).toContain("Keep conflicting files")
  expect(existsSync(join(home, ".local/bin/av"))).toBe(true)
  expect(readFileSync(log, "utf8")).not.toContain("arg=setup")
})

test("--no-setup and CI defer configuration without consuming answers or hanging", () => {
  const disabled = install(source, ["--no-setup"])
  expect(disabled.status).toBe(0)
  expect(disabled.stdout).toContain("Setup deferred")
  env.CI = "true"
  const ci = install(source, [])
  expect(ci.status).toBe(0)
  expect(ci.stdout).toContain("setup --mode order")
  expect(readFileSync(log, "utf8")).not.toContain("arg=setup")
})

test("absolute av invocation discovers a native agent without local bin on the caller PATH", () => {
  const result = install(source)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("Add av to your shell PATH")
  const localBin = join(home, ".local/bin")
  const agent = join(localBin, "cursor-agent")
  writeFileSync(agent, "#!/bin/sh\nexit 0\n")
  chmodSync(agent, 0o755)
  expect(env.PATH?.split(":")).not.toContain(localBin)
  const invocation = spawnSync(join(localBin, "av"), ["order", "Fix the requested behavior"], {
    cwd: target,
    env: { ...env, AV_TEST_RESOLVE_AGENT: "cursor-agent" },
    encoding: "utf8",
    timeout: 5_000,
  })
  expect(invocation.status).toBe(0)
  expect(readFileSync(log, "utf8")).toContain(`agent=${agent}`)
})

test("remote stdin install keeps a persistent checkout and updates it safely on rerun", () => {
  const script = readFileSync(join(source, "scripts/install.sh"), "utf8")
  const invoke = () =>
    spawnSync("bash", ["-s", "--", "--yes", "--no-workflows"], {
      input: script,
      cwd: target,
      env,
      encoding: "utf8",
      timeout: 10_000,
    })
  expect(invoke().status).toBe(0)
  const checkout = join(home, ".local/share/agent-valley")
  expect(existsSync(join(checkout, "apps/cli/src/index.ts"))).toBe(true)
  expect(readFileSync(join(home, ".local/bin/av"), "utf8")).toContain("agent-valley/apps/cli/src/index.ts")
  expect(invoke().status).toBe(0)
  expect(readFileSync(log, "utf8")).toContain("git=pull")
  expect(existsSync(checkout)).toBe(true)
})

test("a piped rerun inside the persistent checkout skips copying files over themselves", () => {
  env.AGENT_VALLEY_INSTALL_DIR = source
  mkdirSync(join(source, ".git"))
  const result = spawnSync("bash", ["-s", "--", "--yes", "--no-workflows"], {
    input: readFileSync(join(source, "scripts/install.sh"), "utf8"),
    cwd: source,
    env,
    encoding: "utf8",
    timeout: 5_000,
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("already contains the harness")
  expect(readFileSync(join(source, "AGENTS.md"), "utf8")).toBe("Source instructions\n")
})

test("installer retains unrelated checkout files and existing av executables", () => {
  const checkout = join(home, ".local/share/agent-valley")
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, "keep.txt"), "user file")
  const remote = spawnSync("bash", ["-s", "--", "--yes", "--no-workflows"], {
    input: readFileSync(join(source, "scripts/install.sh"), "utf8"),
    cwd: target,
    env,
    encoding: "utf8",
    timeout: 5_000,
  })
  expect(remote.status).toBe(1)
  expect(remote.stderr).toContain("existing files were retained")
  expect(readFileSync(join(checkout, "keep.txt"), "utf8")).toBe("user file")
  mkdirSync(join(home, ".local/bin"), { recursive: true })
  writeFileSync(join(home, ".local/bin/av"), "operator executable\n")
  const local = install(source)
  expect(local.status).toBe(1)
  expect(local.stderr).toContain("already exists")
  expect(readFileSync(join(home, ".local/bin/av"), "utf8")).toBe("operator executable\n")
})

test("outdated runtimes provision the pinned versions through mise before dependency installation", () => {
  env.AV_TEST_NODE_VERSION = "v22.0.0"
  env.AV_TEST_RUNTIME_DIR = join(root, "managed runtimes")
  executable(
    "mise",
    `
printf 'mise=%s\\n' "$*" >> "$AV_TEST_LOG"
if [[ "$1" == --yes && "$2" == install ]]; then
  mkdir -p "$AV_TEST_RUNTIME_DIR/node/bin" "$AV_TEST_RUNTIME_DIR/bun/bin"
  printf '#!/bin/bash\\nprintf "v26.10.0\\\\n"\\n' > "$AV_TEST_RUNTIME_DIR/node/bin/node"
  cp "$(command -v bun)" "$AV_TEST_RUNTIME_DIR/bun/bin/bun"
  chmod +x "$AV_TEST_RUNTIME_DIR/node/bin/node" "$AV_TEST_RUNTIME_DIR/bun/bin/bun"
elif [[ "$1" == where ]]; then
  case "$2" in node@*) echo "$AV_TEST_RUNTIME_DIR/node";; bun@*) echo "$AV_TEST_RUNTIME_DIR/bun";; esac
else exit 1; fi
`,
  )
  const result = install(source)
  expect(result.status).toBe(0)
  const calls = readFileSync(log, "utf8")
  expect(calls).toContain("mise=--yes install node@26.10.0 bun@1.4.2")
  expect(calls.indexOf("mise=--yes install")).toBeLessThan(calls.indexOf("arg=install"))
  const template = join(root, "mise template")
  cpSync(join(bin, "mise"), template)
  rmSync(join(bin, "mise"))
  env.AV_TEST_MISE_TEMPLATE = template
  executable(
    "curl",
    `
printf 'curl=%s\\n' "$*" >> "$AV_TEST_LOG"
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cp "$AV_TEST_MISE_TEMPLATE" "$HOME/.local/bin/mise"
chmod +x "$HOME/.local/bin/mise"
INSTALLER
`,
  )
  expect(install(source).status).toBe(0)
  expect(readFileSync(log, "utf8")).toContain("curl=-fsSL https://mise.run")
  expect(existsSync(join(home, ".local/bin/mise"))).toBe(true)
})

test("curl-style piping reconnects the setup wizard to the terminal", () => {
  const python = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" })
  if (python.status !== 0) return
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ['AV_TEST_TARGET'])
    os.execv('/bin/bash', ['/bin/bash', '-c', 'cat "$AV_TEST_INSTALLER" | bash -s -- --no-workflows'])
output = b''
answered = False
deadline = time.time() + 8
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try: part = os.read(fd, 65536)
        except OSError: break
        if not part: break
        output += part
        if not answered and b'Proceed?' in output:
            os.write(fd, b'y\\n')
            answered = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        print(output.decode(errors='replace'))
        sys.exit(os.waitstatus_to_exitcode(status))
else:
    os.kill(pid, 9)
    print('Installer timed out', output.decode(errors='replace'))
    sys.exit(1)
_, status = os.waitpid(pid, 0)
print(output.decode(errors='replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`,
    ],
    {
      cwd: target,
      env: { ...env, AV_TEST_TARGET: target, AV_TEST_INSTALLER: join(source, "scripts/install.sh") },
      encoding: "utf8",
      timeout: 12_000,
    },
  )
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  const calls = readFileSync(log, "utf8")
  expect(calls).toContain(`cwd=${target}`)
  expect(calls).toContain("arg=setup\narg=--mode\narg=order")
  expect(calls).toContain("stdin=tty")
})
