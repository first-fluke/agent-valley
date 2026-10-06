import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as containerObservation from "@agent-valley/core/chief/container-observation"
import { containerObservationPolicySchema } from "@agent-valley/core/chief/container-observation-policy"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { addOrganizationMemory, listOrganizationOutcomes } from "@agent-valley/core/chief/organization"
import { MissionStore } from "@agent-valley/core/chief/store"
import { planSandboxedSpawn } from "@agent-valley/core/sessions/sandbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverAgents } from "../agent-discovery"
import { runOrder } from "../chief"
import type { OrderOptions } from "../chief-config"
import { initializeOperation, operationStore } from "../chief-continuous"

vi.mock("@agent-valley/core/sessions/sandbox", () => ({ planSandboxedSpawn: vi.fn() }))
vi.mock("../agent-discovery", () => ({ discoverAgents: vi.fn() }))
vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))

const exec = promisify(execFile)
const verify =
  'mkdir -p .agent-valley && test "$(cat deliverable.txt)" = accepted && printf verified > .agent-valley/verified.txt'
let root: string
let repo: string
let logPath: string

async function fakeClaude(mode: "success" | "repair" | "interrupt" = "success", directorOrder: readonly string[] = []) {
  const script = join(root, "fake-claude.cjs")
  await writeFile(
    script,
    `
const fs = require('node:fs');
const log = ${JSON.stringify(logPath)};
const directorOrder = ${JSON.stringify(directorOrder)};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const stage = prompt.startsWith('You are the Chief Director coordinating') ? 'plan'
    : prompt.startsWith("Review the mission plan as the Chief Director's Technical Director") ? 'technical-review'
    : prompt.startsWith("Review the mission goal as the Chief Director's Design Director") ? 'design-review'
    : prompt.startsWith("Review the mission goal as the Chief Director's Marketing Director") ? 'marketing-review'
    : prompt.startsWith('You are the Chief Director supervising') ? 'supervise'
    : prompt.startsWith("Write the Chief Director's outcome report") ? 'report'
    : prompt.startsWith('Perform the Chief Director') ? 'final-review'
    : prompt.startsWith('Independently review') ? 'review' : 'work';
  const directorIndex = directorOrder.indexOf(stage);
  if (directorIndex > 0) {
    const preceding = directorOrder.slice(0, directorIndex);
    const deadline = Date.now() + 5000;
    while (!preceding.every(previous => fs.existsSync(log + '.' + previous + '.completed'))) {
      if (Date.now() >= deadline) throw new Error('Director fixture did not complete its preceding parallel stages');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
  const workers = calls.filter(call => call.stage === 'work').length;
  fs.appendFileSync(log, JSON.stringify({ stage, cwd: process.cwd(), prompt }) + '\\n');
  let result;
  let isError = false;
  if (stage === 'plan') {
    const actors = [
      { id: 'chief-director', name: 'Delivery lead', role: 'Coordinate the requested deliverable', actorType: 'claude', skills: [] },
      { id: 'technical-director', name: 'CTO', role: 'Review stack costs, dependencies, reuse and maintainability', actorType: 'claude', skills: [] },
      { id: 'design-director', name: 'CDO', role: 'Review usability with evidence and persona testing', actorType: 'claude', skills: [] },
      { id: 'marketing-director', name: 'CMO', role: 'Improve promotion, revenue and ROI using evidence', actorType: 'claude', skills: [] },
      { id: 'writer', name: 'Deliverable writer', role: 'Write the requested file', actorType: 'claude', skills: [] },
      { id: 'reviewer', name: 'File reviewer', role: 'Independently inspect the deliverable', actorType: 'claude', skills: [] }
    ];
    if (prompt.includes('oma-fixture-helper')) actors[4].skills = ['oma-fixture-helper'];
    result = JSON.stringify({ goalBrief: { interpretation: 'Create a checked file deliverable', assumptions: ['The requested file is deliverable.txt'], successCriteria: ['deliverable.txt contains accepted'] }, ...(prompt.includes('availableActors') ? { actors } : {}), tasks: [{ id: 'write', title: 'Write deliverable', actorId: 'writer',
      instructions: 'Create deliverable.txt containing accepted', acceptance: ['deliverable.txt contains accepted'], dependencies: [] }] });
  } else if (stage === 'technical-review') {
    result = JSON.stringify({ passed: true, summary: 'Use the existing stack and a plain file; add no dependency or duplicate subsystem.', findings: [] });
  } else if (stage === 'design-review') {
    result = JSON.stringify({ passed: true, summary: 'No user interface is changed. Keep the deliverable easy to inspect; no field-test data is available.', findings: [] });
  } else if (stage === 'marketing-review') {
    result = JSON.stringify({ passed: true, summary: 'Deliver the checked file first. No product revenue or ROI data is available; make no financial claim.', findings: [] });
  } else if (stage === 'work') {
    const wrong = ${JSON.stringify(mode)} !== 'success' && workers === 0;
    fs.writeFileSync('deliverable.txt', wrong ? 'partial' : 'accepted');
    isError = ${JSON.stringify(mode)} === 'interrupt' && workers === 0;
    result = isError ? 'Simulated CLI connection failure' : 'Wrote deliverable.txt. Inspect it and run the acceptance check.';
  } else if (stage === 'supervise') {
    isError = ${JSON.stringify(mode)} === 'interrupt' && calls.filter(call => call.stage === 'supervise').length === 0;
    result = isError ? 'Simulated Chief Director connection failure' : JSON.stringify(prompt.includes('Docker source access unavailable')
      ? { action: 'wait', reason: 'Docker source access unavailable; recheck the same configured target', retryAfterSec: 30 }
      : { action: 'repair', reason: 'The worker connection failed before completing the file', taskId: 'write', instructions: 'Finish deliverable.txt containing accepted' });
  } else if (stage === 'report') {
    const accepted = fs.existsSync('deliverable.txt') && fs.readFileSync('deliverable.txt', 'utf8') === 'accepted';
    result = JSON.stringify({ summary: accepted ? 'Verified requested file' : 'File remains incomplete', eli5: accepted ? 'The requested file is ready and passed its check.' : 'The file is unfinished; the Chief Director connection must recover before it can finish.', goalAssessment: accepted ? 'The saved success criterion is satisfied.' : 'The saved success criterion is not satisfied.', assumptions: [], decisions: [], deliverables: ['deliverable.txt'], checks: [accepted ? 'Acceptance command passed' : 'Acceptance command has not passed'], remaining: accepted ? [] : ['Resume the order after restoring the Chief Director connection'] });
  } else {
    const delivered = fs.existsSync('deliverable.txt');
    result = JSON.stringify({ passed: delivered, summary: 'Inspected deliverable.txt in the mission worktree.', findings: delivered ? [] : ['Write deliverable.txt'], ...(stage === 'final-review' ? { criteria: [{ criterion: 'deliverable.txt contains accepted', passed: delivered, evidence: 'Read deliverable.txt and checked the acceptance command result' }] } : {}) });
  }
  // The runner can stop this process immediately after its terminal event.
  if (directorIndex >= 0) fs.writeFileSync(log + '.' + stage + '.completed', 'completed');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: isError, result, duration_ms: 1 }) + '\\n');
});
`,
  )
  vi.mocked(planSandboxedSpawn).mockImplementation(async () => ({
    command: process.execPath,
    args: [script],
    sandboxed: false,
    platform: process.platform,
    networkAllowlist: [],
  }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-cli-"))
  repo = join(root, "repo")
  logPath = join(root, "calls.jsonl")
  await mkdir(repo)
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo })
  await exec("git", ["config", "user.email", "chief-test@example.test"], { cwd: repo })
  await exec("git", ["config", "user.name", "Chief Director Test"], { cwd: repo })
  await writeFile(join(repo, "README.md"), "Mission fixture\n")
  await exec("git", ["add", "README.md"], { cwd: repo })
  await exec("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign"], { cwd: repo })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(discoverAgents).mockResolvedValue([
    { agentType: "claude", readiness: "ready", reason: "Fixture authentication" },
  ])
  await fakeClaude()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function calls(): Promise<Array<{ stage: string; cwd: string; prompt: string }>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

describe("chief CLI mission lifecycle with real sessions and Git", () => {
  it("pins configured container targets in operation children and rechecks them on resume despite edited config", async () => {
    const policy = containerObservationPolicySchema.parse({
      targets: [{ id: "api", kind: "docker", container: "production-api" }],
      cpu_percent_threshold: 80,
    })
    await writeFile(join(root, "av.yaml"), JSON.stringify({ chief: { container_observation: policy } }))
    const operation = await initializeOperation(
      "Create a verified deliverable",
      { workspace: repo, verify, model: "selected-chief-model", timeout: "10" },
      root,
    )
    expect(operation.containerObservationPolicy).toEqual(policy)
    operation.baseline = await prepareContinuousBaseline(
      operation.repositoryRoot,
      operation.id,
      operation.repositoryRoot,
    )
    operation.currentMissionId = "container-child"
    operation.decision = {
      action: "execute",
      goal: operation.charter,
      reason: "Requested deliverable",
      evidence: ["operator-goal"],
    }
    operation.phase = "running"
    await operationStore(await realpath(root)).save(operation)
    await writeFile(
      join(root, "av.yaml"),
      JSON.stringify({
        chief: {
          container_observation: {
            ...policy,
            enabled: false,
            targets: [{ id: "other", kind: "docker", container: "other" }],
          },
        },
      }),
    )
    let available = true
    const collect = vi.spyOn(containerObservation, "collectContainerObservation").mockImplementation(async (pinned) => {
      expect(pinned).toEqual(policy)
      const now = new Date()
      const fingerprint = (available ? "a" : "b").repeat(64)
      return {
        collectedAt: now.toISOString(),
        nextPollAt: new Date(now.getTime() + 30_000).toISOString(),
        fingerprint,
        results: [
          {
            targetId: "api",
            kind: "docker",
            status: available ? "collected" : "unavailable",
            state: "running",
            ready: true,
            health: "healthy",
            cpuPercent: 3,
            memoryPercent: 20,
            logsAvailable: true,
            statsAvailable: true,
            issues: [],
            fingerprint,
            ...(available ? {} : { reason: "Docker source access unavailable" }),
          },
        ],
      }
    })
    const mission = await runOrder(
      operation.charter,
      {
        ...(operation.settings as OrderOptions),
        missionId: operation.currentMissionId,
        operationId: operation.id,
        baselineWorkspace: operation.baseline.path,
      },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.containerObservationPolicy).toEqual(policy)
    expect(collect).toHaveBeenCalledTimes(2)
    available = false
    collect.mockClear()
    const resumed = await runOrder(undefined, { resume: mission.id }, root)
    expect(resumed).toMatchObject({
      status: "waiting",
      verification: { ok: true },
      execution: { failureKind: "chief-wait" },
    })
    expect(Number.isFinite(Date.parse(resumed.execution?.nextRunAt ?? ""))).toBe(true)
    expect(resumed.supervision?.decisions.at(-1)).toMatchObject({ action: "wait", retryAfterSec: 30 })
    expect((await calls()).filter((call) => call.stage === "work")).toHaveLength(1)
    expect(resumed.containerObservationPolicy).toEqual(policy)
    expect(resumed.personas.find((actor) => actor.id === resumed.chiefId)?.model).toBe("selected-chief-model")
    expect(collect).toHaveBeenCalledOnce()
    const rendered = await readFile(join(root, ".agent-valley/reports", `${mission.id}.md`), "utf8")
    expect(rendered).toContain("코드 검증과 별도로")
    expect(rendered).toContain("CPU=3%")
    expect(rendered).toContain("threshold 80")
    expect(rendered).toContain("unavailable")
  }, 20_000)

  it("reuses source-repository decisions and stores verified evidence with unknown costs intact", async () => {
    await addOrganizationMemory(repo, {
      kind: "stack-standard",
      content: "Deliverable files use the existing plain-text format",
      source: "Operator decision",
    })
    const mission = await runOrder("Create a verified deliverable", { workspace: repo, verify, timeout: "10" }, root)
    expect(mission.repositoryRoot).toBe(repo)
    expect(mission.organizationContext?.memories[0]?.content).toContain("plain-text")
    expect((await calls()).find((call) => call.stage === "plan")?.prompt).toContain("Operator decision")
    const outcomes = await listOrganizationOutcomes(repo)
    expect(outcomes).toHaveLength(1)
    expect(
      outcomes[0]?.evidence.some((item) => item.path === "deliverable.txt" && /^[a-f0-9]{64}$/.test(item.sha256)),
    ).toBe(true)
    expect(outcomes[0]?.verification?.ok).toBe(true)
    const worker = outcomes[0]?.runs.find((run) => run.stage === "work")
    expect(worker).toMatchObject({
      taskId: "write",
      actorType: "claude",
      outcome: "passed",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
    expect(worker?.elapsedMs).toBeGreaterThanOrEqual(0)
    const next = await runOrder("Create another verified deliverable", { workspace: repo, verify, timeout: "10" }, root)
    expect(next.organizationContext?.outcomes.some((item) => item.missionId === mission.id)).toBe(true)
    expect(next.organizationContext?.routeEvidence[0]).toMatchObject({ samples: 1, successes: 1, totalCostUsd: null })
  }, 20_000)

  it("keeps organization memory disabled through the final-review refresh", async () => {
    await addOrganizationMemory(repo, {
      kind: "stack-standard",
      content: "PRIVATE_DISABLED_MEMORY_MARKER",
      source: "Operator decision",
    })
    await writeFile(join(root, "av.yaml"), JSON.stringify({ chief: { memory: false } }))
    const mission = await runOrder("Create a verified deliverable", { workspace: repo, verify, timeout: "10" }, root)
    expect(mission.organizationContext).toBeUndefined()
    expect((await calls()).some((call) => call.prompt.includes("PRIVATE_DISABLED_MEMORY_MARKER"))).toBe(false)
    expect(await listOrganizationOutcomes(repo)).toEqual([])
  }, 20_000)

  it("completes an order without tracker config, preserves isolation, and rechecks a saved mission", async () => {
    const sigint = process.listenerCount("SIGINT")
    const mission = await runOrder(
      "Create a verified deliverable",
      { workspace: repo, verify, model: "selected-chief-model", timeout: "10" },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.status).toBe("completed")
    expect(mission.tasks[0]?.reviewerId).toBe("technical-director")
    expect(mission.availableAgents).toEqual(["claude"])
    expect(mission.personas.map((persona) => persona.id)).toEqual([
      "chief-director",
      "technical-director",
      "design-director",
      "marketing-director",
      "writer",
      "reviewer",
    ])
    expect(mission.technicalReview?.review.summary).toContain("existing stack")
    expect(mission.designReview?.review.summary).toContain("No user interface")
    expect(mission.marketingReview?.review.summary).toContain("ROI data")
    expect(mission.plan?.tasks[0]?.personaId).toBe("writer")
    expect(mission.goalBrief?.successCriteria).toEqual(["deliverable.txt contains accepted"])
    expect(mission.report?.eli5).toBe("The requested file is ready and passed its check.")
    const report = await readFile(join(root, ".agent-valley/reports", `${mission.id}.md`), "utf8")
    expect(report).toContain("The requested file is ready")
    expect(mission.personas.find((persona) => persona.id === mission.chiefId)?.model).toBe("selected-chief-model")
    expect(
      mission.personas.filter((persona) => persona.id !== mission.chiefId).every((persona) => !persona.model),
    ).toBe(true)
    expect(vi.mocked(planSandboxedSpawn).mock.calls.map(([spawn]) => spawn.args.includes("--model"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
    ])
    expect(discoverAgents).toHaveBeenCalledOnce()
    expect(mission.workspace.path).not.toBe(repo)
    expect(await readFile(join(mission.workspace.path, "deliverable.txt"), "utf8")).toBe("accepted")
    expect(await readFile(join(mission.workspace.path, ".agent-valley/verified.txt"), "utf8")).toBe("verified")
    await expect(readFile(join(repo, "deliverable.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    const stages = (await calls()).map((call) => call.stage)
    expect(stages.slice(0, 3).sort()).toEqual(["design-review", "marketing-review", "technical-review"])
    expect(stages.slice(3)).toEqual(["plan", "work", "review", "final-review", "report"])
    const canonicalWorkspace = await realpath(mission.workspace.path)
    expect((await calls()).every((call) => call.cwd === canonicalWorkspace)).toBe(true)
    expect(await new MissionStore(join(root, ".agent-valley/missions")).load(mission.id)).toEqual(mission)
    const resumed = await runOrder(undefined, { resume: mission.id }, root)
    expect(resumed.status).toBe("completed")
    expect(resumed.tasks[0]?.attempts).toBe(1)
    expect(resumed.personas).toEqual(mission.personas)
    expect(vi.mocked(planSandboxedSpawn).mock.lastCall?.[0].args).toContain("selected-chief-model")
    expect(discoverAgents).toHaveBeenCalledOnce()
    const resumedStages = (await calls()).map((call) => call.stage)
    expect(resumedStages.slice(0, 3).sort()).toEqual(["design-review", "marketing-review", "technical-review"])
    expect(resumedStages.slice(3)).toEqual([
      "plan",
      "work",
      "review",
      "final-review",
      "report",
      "final-review",
      "report",
    ])
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([`${mission.id}.json`])
    expect(process.listenerCount("SIGINT")).toBe(sigint)
  }, 20_000)

  it("preserves an explicit roster while detecting ready vendors for independent reviews", async () => {
    const personas = [
      { id: "chief", name: "Configured chief", role: "Preserve operator roles", agentType: "claude", skills: [] },
      { id: "writer", name: "Configured writer", role: "Write a file", agentType: "claude", skills: [] },
      { id: "reviewer", name: "Configured reviewer", role: "Inspect a file", agentType: "claude", skills: [] },
    ]
    await writeFile(join(root, "personas.yaml"), JSON.stringify({ chief: "chief", personas }))
    const mission = await runOrder(
      "Create a verified deliverable",
      { workspace: repo, verify, personas: "personas.yaml", timeout: "10" },
      root,
    )
    expect(mission.status).toBe("completed")
    expect(mission.personas.slice(0, personas.length)).toEqual(personas)
    expect(mission.personas.find((persona) => persona.id === "technical-director")).toMatchObject({
      agentType: "claude",
    })
    expect(mission.personas.find((persona) => persona.id === "design-director")).toMatchObject({ agentType: "claude" })
    expect(mission.personas.find((persona) => persona.id === "marketing-director")).toMatchObject({
      agentType: "claude",
    })
    expect(mission).not.toHaveProperty("availableAgents")
    expect(discoverAgents).toHaveBeenCalledOnce()
    expect(mission.operatingPolicy?.readyActors).toEqual(["claude"])
    expect(mission.operations?.reviewDecisions[0]).toMatchObject({
      crossVendor: false,
      workerActorType: "claude",
      reviewerActorType: "claude",
    })
  }, 20_000)

  it("selects an installed OMA skill without receipt enforcement and loads only its assigned body", async () => {
    const path = join(repo, ".agents/skills/oma-fixture-helper")
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, "SKILL.md"),
      "---\nname: oma-fixture-helper\ndescription: Write a checked file deliverable\n---\n\nFixture helper instructions: inspect the actual file before reporting completion.\n",
    )
    const mission = await runOrder("Create a verified deliverable", { workspace: repo, verify, timeout: "10" }, root)
    expect(mission.oma).toBe(false)
    expect(mission.availableSkills).toEqual([
      {
        name: "oma-fixture-helper",
        description: "Write a checked file deliverable",
        path: join(await realpath(mission.workspace.path), ".agents/skills/oma-fixture-helper/SKILL.md"),
      },
    ])
    expect(mission.personas.find((persona) => persona.id === "writer")?.skills).toEqual(["oma-fixture-helper"])
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toContain("Fixture helper instructions")
    const stages = await calls()
    expect(stages.find((call) => call.stage === "plan")?.prompt).toContain("Write a checked file deliverable")
    expect(stages.find((call) => call.stage === "work")?.prompt).toContain("Fixture helper instructions")
    expect(stages.find((call) => call.stage === "review")?.prompt).not.toContain("Fixture helper instructions")
    expect(await readFile(join(root, ".agent-valley/reports", `${mission.id}.md`), "utf8")).toMatch(
      /oma\\?-fixture\\?-helper/,
    )
  }, 20_000)

  it.each([
    { schedule: "forward", directorOrder: ["technical-review", "design-review", "marketing-review"] },
    { schedule: "reversed", directorOrder: ["marketing-review", "design-review", "technical-review"] },
    { schedule: "design first", directorOrder: ["design-review", "technical-review", "marketing-review"] },
  ])(
    "repairs real verifier failures with $schedule Directors instead of trusting successful messages",
    async ({ directorOrder }) => {
      await fakeClaude("repair", directorOrder)
      const mission = await runOrder(
        "Create a verified deliverable",
        { workspace: repo, verify, agent: "claude", repairs: "1", timeout: "10", parallel: "3" },
        root,
      )
      expect(mission.status).toBe("completed")
      expect(mission.tasks[0]?.attempts).toBe(2)
      expect(mission.repairRound).toBe(1)
      const stages = (await calls()).map((call) => call.stage)
      expect(stages.slice(0, 3)).toEqual(directorOrder)
      expect(stages.slice(0, 3).sort()).toEqual(["design-review", "marketing-review", "technical-review"])
      expect(stages.slice(3)).toEqual(["plan", "work", "review", "work", "review", "final-review", "report"])
      expect(await readFile(join(mission.workspace.path, "deliverable.txt"), "utf8")).toBe("accepted")
    },
    20_000,
  )

  it("protects an unavailable Chief checkpoint and retains the worktree for explicit advanced resume", async () => {
    await fakeClaude("interrupt")
    const paused = await runOrder(
      "Create a verified deliverable",
      { workspace: repo, verify, agent: "claude", model: "selected-chief-model", repairs: "0", timeout: "10" },
      root,
    )
    expect(paused.status).toBe("paused")
    expect(paused.error).toContain("Simulated Chief Director connection failure")
    expect(paused.execution?.failureKind).toBe("chief-unavailable")
    const store = new MissionStore(join(root, ".agent-valley/missions"))
    const [failed] = await store.list()
    if (!failed) throw new Error("Expected saved failed mission")
    expect(failed.status).toBe("paused")
    expect(failed.id).toBe(paused.id)
    expect(failed.report?.eli5).toContain("Simulated Chief Director connection failure")
    expect(await readFile(join(root, ".agent-valley/reports", `${failed.id}.md`), "utf8")).toContain(
      "Simulated Chief Director connection failure",
    )
    expect(await readFile(join(failed.workspace.path, "deliverable.txt"), "utf8")).toBe("partial")
    const spent = structuredClone(failed.execution)
    const beforeResume = await calls()
    const protectedResume = await runOrder(undefined, { resume: failed.id }, root)
    expect(protectedResume.status).toBe("paused")
    expect(protectedResume.execution).toEqual(spent)
    expect(await calls()).toEqual(beforeResume)
    const resumed = await runOrder(undefined, { resume: failed.id, retry: true }, root)
    expect(resumed.status).toBe("completed")
    expect(resumed.id).toBe(failed.id)
    expect(resumed.personas.find((actor) => actor.id === resumed.chiefId)?.model).toBe("selected-chief-model")
    expect(resumed.workspace.path).toBe(failed.workspace.path)
    expect(resumed.tasks[0]?.attempts).toBe(2)
    expect(resumed.supervision?.rounds).toBe(2)
    expect(resumed.supervision?.decisions[0]?.action).toBe("repair")
    expect((await calls()).filter((call) => call.stage === "plan")).toHaveLength(1)
  }, 20_000)

  it("rejects resume contract changes and releases its lock after CLI validation errors", async () => {
    await expect(runOrder(undefined, { workspace: repo, verify }, root)).rejects.toThrow("Give the chief a goal")
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([])
    await expect(runOrder("Changed goal", { resume: "mission-id" }, root)).rejects.toThrow("Pass only --resume")
    expect(await readdir(join(root, ".agent-valley/missions"))).toEqual([])
  })
})
