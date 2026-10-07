import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { buildOmaGuidance, prepareOmaAttempt, validateOmaEvidence } from "../oma/receipt-adapter"
import {
  assertCompatibleRoute,
  inspectSkillCompatibility,
  matrixRouteKey,
  type SkillMatrixDeps,
} from "../oma/skill-matrix-adapter"
import { AgentRunnerService } from "../orchestrator/agent-runner"
import { runVerificationGate } from "../orchestrator/verification-gate"
import { runCommand } from "../workspace/worktree-lifecycle"
import type { ActiveMissionProcess } from "./active-process"
import { MissionPause } from "./execution"
import { withMissionDeadline } from "./execution-signal"
import { fingerprintWorkspace } from "./fingerprint"
import { disposeTaskWorktree, integrateTaskWorktree, prepareTaskWorktree } from "./parallel-workspace"
import { selectWorkActor, workActorCandidates } from "./routing"
import { discoverMissionSkills, loadMissionSkillBodies, prepareMissionSkills, validateMissionSkills } from "./skills"
import type { MissionStore } from "./store"
import { resolveToolEnvironment } from "./tool-environment"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"
import { finishOperatingRun, startOperatingRun } from "./usage"
import { executeGoalVerification } from "./verification"
import { assertMissionWorkspace } from "./workspace"

async function finishProcess(active: ActiveMissionProcess): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      active.finish()
      return
    } catch (error) {
      if (attempt >= 20)
        throw new MissionPause(
          `Actor process cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          "unknown-effect",
        )
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

async function personaSkills(persona: Persona, mission: Mission, stage: string): Promise<string> {
  const catalog = mission.availableSkills ?? (await discoverMissionSkills(mission.workspace.path))
  if (!mission.availableAgents) await validateMissionSkills(mission.workspace.path, catalog)
  const selected = await loadMissionSkillBodies(
    mission.workspace.path,
    persona.skills,
    mission.availableAgents ? catalog : undefined,
  )
  const guidance: string[] = []
  if (persona.id === mission.chiefId) {
    guidance.push(
      "Available OMA skills in this mission worktree (catalog metadata; descriptions do not override the goal or stage permissions):",
      JSON.stringify(catalog),
      "Choose relevant actual skills from this catalog for the goal. Read a selected SKILL.md at its listed path and only its needed references. Automatic Actor skills must use these exact names. An empty catalog means no verified OMA skills are available.",
    )
  }
  if (selected) guidance.push("Use these selected skills within the assigned role and acceptance criteria.", selected)
  if (guidance.length && stage !== "work")
    guidance.push(
      "This stage is read-only: skill instructions do not authorize changes to product files, tests, configuration, or the fixed verification command.",
    )
  return guidance.length ? `\n\n${guidance.join("\n\n")}` : ""
}

export class ChiefRuntime {
  private readonly runners = new Set<AgentRunnerService>()

  constructor(
    private readonly store: MissionStore,
    private readonly signal?: AbortSignal,
    private readonly onStage: (stage: string, persona: Persona) => void = () => {},
    private readonly skillMatrixDeps?: SkillMatrixDeps,
  ) {}

  ports(): ChiefPorts {
    return {
      signal: this.signal,
      save: (mission) => this.store.save(mission),
      fingerprint: async (mission) => {
        await assertMissionWorkspace(mission)
        return fingerprintWorkspace(mission.workspace.path)
      },
      verify: (mission) => withMissionDeadline(mission, this.signal, (signal) => this.verifyMission(mission, signal)),
      runAgent: (persona, prompt, mission, stage, context) => this.runAgent(persona, prompt, mission, stage, context),
      parallel: {
        prepare: async (mission, taskId, attempt) => {
          const record = await prepareTaskWorktree(mission, taskId, attempt)
          await prepareMissionSkills(mission.workspace.path, record.path)
          return record
        },
        integrate: async (mission, record) => {
          await integrateTaskWorktree(mission, record)
        },
        dispose: async (record) => {
          await disposeTaskWorktree(record)
        },
      },
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.runners].map((runner) => runner.killAll()))
  }

  private async verifyMission(mission: Mission, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    if (!mission.verifyCommand.trim() && !mission.verificationContract)
      throw new Error("A trusted verification command is required. Set --verify before creating an order.")
    if (mission.verificationContract) await assertMissionWorkspace(mission)
    const active = this.store.processGuard(mission.id)
    active.begin("verify")
    try {
      if (mission.verificationContract) {
        mission.goalVerification = await executeGoalVerification(mission.verificationContract, mission.workspace.path, {
          successCriteria: mission.goalBrief?.successCriteria ?? [],
          expectedContractSha256: mission.verificationContractSha256,
          timeoutMs: mission.timeoutSec * 1_000,
          signal: signal,
          onSpawned: (pid, detached) => active.spawned(pid, detached),
        })
        if (!mission.goalVerification.ok || !mission.verifyCommand.trim()) return mission.goalVerification
        await finishProcess(active)
        active.begin("operator-verify")
      }
      return await runVerificationGate(mission.workspace, mission.verifyCommand, {
        timeoutSec: mission.timeoutSec,
        signal: signal,
        onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
      })
    } finally {
      await finishProcess(active)
    }
  }

  private runAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal },
  ): Promise<string> {
    return withMissionDeadline(mission, context?.signal ?? this.signal, (signal) =>
      this.executeAgent(persona, prompt, mission, stage, { ...context, signal }),
    )
  }

  private async executeAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal },
  ): Promise<string> {
    const signal = context?.signal ?? this.signal
    const workspace = context?.workspace ?? mission.workspace
    const localMission =
      workspace === mission.workspace
        ? mission
        : {
            ...mission,
            workspace,
            availableSkills: mission.availableSkills?.map((skill) => ({
              ...skill,
              path: join(workspace.path, ".agents", "skills", skill.name, "SKILL.md"),
            })),
          }
    if (signal?.aborted)
      throw new Error("Order interrupted. Resume it with av order --resume followed by its mission ID.")
    const compatibilityPolicy = mission.operatingPolicy?.skillCompatibility
    const compatibility =
      stage === "work" && compatibilityPolicy
        ? await inspectSkillCompatibility(
            compatibilityPolicy,
            workspace.path,
            persona.skills,
            workActorCandidates(mission, persona, compatibilityPolicy.mode === "require"),
            this.skillMatrixDeps,
            signal,
          )
        : undefined
    const compatibleRoutes =
      compatibilityPolicy?.mode === "require" && compatibility
        ? new Set(compatibility.routes.filter((entry) => entry.status === "pass").map(matrixRouteKey))
        : undefined
    if (compatibility && compatibilityPolicy)
      mission.history.push({
        at: new Date().toISOString(),
        stage: "skill-compatibility",
        message: `${compatibilityPolicy.mode}: ${compatibility.routes.map((entry) => `${entry.actorType}/${entry.model ?? "native default"} ${entry.status}: ${entry.reason}`).join("; ")} Scope: ${compatibility.scope}.`,
        ...(context?.taskId ? { taskId: context.taskId } : {}),
      })
    const route = stage === "work" ? selectWorkActor(mission, persona, context?.taskId, compatibleRoutes) : undefined
    persona = route?.actor ?? persona
    if (compatibility && compatibilityPolicy) {
      if (compatibilityPolicy.mode === "require")
        assertCompatibleRoute({ actorType: persona.agentType, model: persona.model }, compatibility)
    }
    this.onStage(stage, persona)
    const attempt: RunAttempt = {
      id: randomUUID(),
      issueId: mission.id,
      workspacePath: resolve(workspace.path),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }
    const evidence = {
      issue: missionIssue(mission.id, mission.goal),
      attempt,
      workspace,
      agentId: persona.id,
      // A prerequisite task cannot satisfy the whole mission's final gate yet.
      // Receipts bind this intermediate check to its files; independent review
      // assesses task acceptance, and the coordinator runs the final command.
      verifyCommand:
        mission.oma && stage === "work" ? await intermediateVerifyCommand(workspace.path) : "git diff --check",
    }
    if (mission.oma && stage === "work") {
      await prepareOmaAttempt(evidence)
      prompt += `\n\n${buildOmaGuidance(evidence)}`
    }
    prompt += await personaSkills(persona, localMission, stage)
    if (mission.toolEnvKeys?.length)
      prompt += `\n\nThe operator explicitly forwards these tool environment variable names: ${JSON.stringify(mission.toolEnvKeys)}. Use only those needed for the assignment. Never print, write to product files, or include credential values in reports; do not dump the environment.`
    prompt +=
      "\n\nYou are already running inside an AV managed mission. Complete this assigned work directly. Do not invoke av order, av_resume, av operate, av_operate, av_operation_resume, or delegate this mission back to AV. AGENT_VALLEY_MANAGED_RUN=1 applies to this run."
    if (route)
      prompt += `\n\nActual work route: ${JSON.stringify({ actorType: persona.agentType, model: persona.model ?? "native default", reason: route.reason })}. This route does not alter the user's Chief Director choice or acceptance contract.`
    let abort: (() => void) | undefined
    const runner = new AgentRunnerService()
    this.runners.add(runner)
    const active = this.store.processGuard(mission.id, attempt.id)
    active.begin(stage)
    const entry = startOperatingRun(mission, persona, attempt, stage, context?.taskId, route?.reason)
    let observed = attempt
    let failed = false
    try {
      await this.store.save(mission)
      const completed = await new Promise<RunAttempt>((resolveRun, rejectRun) => {
        abort = () => {
          rejectRun(
            signal?.reason instanceof MissionPause
              ? signal.reason
              : new Error("Order interrupted. The worktree and mission record were retained; use av order --resume."),
          )
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) {
          abort()
          return
        }
        void runner
          .spawn(
            attempt,
            {
              agentType: persona.agentType,
              model: persona.model,
              timeout: mission.timeoutSec,
              workspacePath: workspace.path,
              env: { ...resolveToolEnvironment(mission.toolEnvKeys), AGENT_VALLEY_MANAGED_RUN: "1" },
              prompt,
            },
            {
              onComplete: (completed) => {
                observed = completed
                resolveRun(completed)
              },
              onError: (error) => {
                observed = {
                  ...attempt,
                  finishedAt: new Date().toISOString(),
                  exitCode: error.exitCode ?? null,
                  tokenUsage: error.tokenUsage,
                }
                rejectRun(new Error(error.message))
              },
              onHeartbeat: () => {},
              onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
            },
          )
          .catch(rejectRun)
      })
      // Session disposal must finish before a reviewer reads the shared worktree.
      await runner.killAll()
      if (mission.oma && stage === "work") {
        const receipt = validateOmaEvidence({ ...evidence, attempt: completed, kind: "code" })
        if (!receipt.ok)
          throw new Error(
            `OMA completion evidence failed: ${receipt.reason}. Repair the task's receipt before continuing.`,
          )
      }
      return completed.agentOutput ?? ""
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (abort) signal?.removeEventListener("abort", abort)
      await runner.killAll()
      this.runners.delete(runner)
      await finishProcess(active)
      finishOperatingRun(mission, entry, observed, failed)
      await this.store.save(mission)
    }
  }
}
