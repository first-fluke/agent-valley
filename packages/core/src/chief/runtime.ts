import { randomUUID } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { Issue, RunAttempt } from "../domain/models"
import { buildOmaGuidance, prepareOmaAttempt, validateOmaEvidence } from "../oma/receipt-adapter"
import { AgentRunnerService } from "../orchestrator/agent-runner"
import { runVerificationGate } from "../orchestrator/verification-gate"
import { runCommand } from "../workspace/worktree-lifecycle"
import type { ActiveMissionProcess } from "./active-process"
import { fingerprintWorkspace } from "./fingerprint"
import type { MissionStore } from "./store"
import type { ChiefPorts, Mission, Persona } from "./types"
import { assertMissionWorkspace } from "./workspace"

async function finishProcess(active: ActiveMissionProcess): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      active.finish()
      return
    } catch (error) {
      if (attempt >= 20) throw error
      // The process group may briefly contain children awaiting OS reaping.
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
}

export function missionIssue(id: string, goal: string): Issue {
  return {
    id,
    identifier: `ORDER-${id}`,
    title: goal.slice(0, 200),
    description: goal,
    status: { id: "local", name: "In Progress", type: "started" },
    team: { id: "local", key: "ORDER" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
  }
}

/** Pin the intermediate receipt check before the worker can create commits. */
export async function intermediateVerifyCommand(workspacePath: string): Promise<string> {
  const head = await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspacePath })
  const hash = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(hash)) {
    throw new Error(
      "Cannot bind the OMA task check to its starting commit. Restore the mission worktree's Git HEAD before resuming.",
    )
  }
  return `git diff --check ${hash} --`
}

async function personaSkills(persona: Persona, mission: Mission): Promise<string> {
  if (!persona.skills.length) return ""
  const skillsRoot = await realpath(join(mission.workspace.path, ".agents/skills")).catch(() => {
    throw new Error(
      `Persona ${persona.id} requires skills in the target repository. Install its OMA harness or remove skills from the persona profile.`,
    )
  })
  const sections: string[] = []
  let length = 0
  for (const name of persona.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid skill name for persona ${persona.id}: ${name}`)
    const path = await realpath(join(skillsRoot, name, "SKILL.md")).catch(() => {
      throw new Error(
        `Persona ${persona.id} requires ${name}/SKILL.md. Restore that installed skill in ${mission.workspace.path}/.agents/skills before resuming.`,
      )
    })
    if (!path.startsWith(`${skillsRoot}${sep}`))
      throw new Error(`Skill ${name} escapes the skill directory. Fix its symlink before running.`)
    const content = await readFile(path, "utf8")
    length += content.length
    if (length > 256_000)
      throw new Error(`Persona ${persona.id} has more than 256 KB of skill instructions. Select fewer skills.`)
    sections.push(`## Skill ${name}\nSource: ${path}\n${content}`)
  }
  return `\n\nUse these selected skills within the assigned role and acceptance criteria. Planning and review stages must not change product files.\n${sections.join("\n\n")}`
}

export class ChiefRuntime {
  private readonly runner = new AgentRunnerService()

  constructor(
    private readonly store: MissionStore,
    private readonly signal?: AbortSignal,
    private readonly onStage: (stage: string, persona: Persona) => void = () => {},
  ) {}

  ports(): ChiefPorts {
    return {
      signal: this.signal,
      save: (mission) => this.store.save(mission),
      fingerprint: async (mission) => {
        await assertMissionWorkspace(mission)
        return fingerprintWorkspace(mission.workspace.path)
      },
      verify: async (mission) => {
        if (!mission.verifyCommand.trim())
          throw new Error("A trusted verification command is required. Set --verify before creating an order.")
        const active = this.store.processGuard(mission.id)
        active.begin("verify")
        try {
          return await runVerificationGate(mission.workspace, mission.verifyCommand, {
            timeoutSec: mission.timeoutSec,
            signal: this.signal,
            onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
          })
        } finally {
          await finishProcess(active)
        }
      },
      runAgent: (persona, prompt, mission, stage) => this.runAgent(persona, prompt, mission, stage),
    }
  }

  async close(): Promise<void> {
    await this.runner.killAll()
  }

  private async runAgent(persona: Persona, prompt: string, mission: Mission, stage: string): Promise<string> {
    if (this.signal?.aborted)
      throw new Error("Order interrupted. Resume it with av order --resume followed by its mission ID.")
    this.onStage(stage, persona)
    const attempt: RunAttempt = {
      id: randomUUID(),
      issueId: mission.id,
      workspacePath: resolve(mission.workspace.path),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }
    const evidence = {
      issue: missionIssue(mission.id, mission.goal),
      attempt,
      workspace: mission.workspace,
      agentId: persona.id,
      // A prerequisite task cannot satisfy the whole mission's final gate yet.
      // Receipts bind this intermediate check to its files; independent review
      // assesses task acceptance, and the coordinator runs the final command.
      verifyCommand:
        mission.oma && stage === "work" ? await intermediateVerifyCommand(mission.workspace.path) : "git diff --check",
    }
    if (mission.oma && stage === "work") {
      await prepareOmaAttempt(evidence)
      prompt += `\n\n${buildOmaGuidance(evidence)}`
    }
    prompt += await personaSkills(persona, mission)
    let abort: (() => void) | undefined
    const active = this.store.processGuard(mission.id)
    active.begin(stage)
    try {
      const completed = await new Promise<RunAttempt>((resolveRun, rejectRun) => {
        abort = () => {
          rejectRun(
            new Error("Order interrupted. The worktree and mission record were retained; use av order --resume."),
          )
        }
        this.signal?.addEventListener("abort", abort, { once: true })
        if (this.signal?.aborted) {
          abort()
          return
        }
        void this.runner
          .spawn(
            attempt,
            {
              agentType: persona.agentType,
              model: persona.model,
              timeout: mission.timeoutSec,
              workspacePath: mission.workspace.path,
              prompt,
            },
            {
              onComplete: resolveRun,
              onError: (error) => rejectRun(new Error(error.message)),
              onHeartbeat: () => {},
              onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
            },
          )
          .catch(rejectRun)
      })
      // Session disposal must finish before a reviewer reads the shared worktree.
      await this.runner.killAll()
      if (mission.oma && stage === "work") {
        const receipt = validateOmaEvidence({ ...evidence, attempt: completed, kind: "code" })
        if (!receipt.ok)
          throw new Error(
            `OMA completion evidence failed: ${receipt.reason}. Repair the task's receipt before continuing.`,
          )
      }
      return completed.agentOutput ?? ""
    } finally {
      if (abort) this.signal?.removeEventListener("abort", abort)
      await this.runner.killAll()
      await finishProcess(active)
    }
  }
}
