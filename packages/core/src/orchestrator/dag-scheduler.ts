/**
 * DagScheduler — Application-layer component for dependency graph management.
 * Manages DAG state, persists to JSON cache, and provides query methods.
 * Delegates pure DAG logic to domain/dag.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  allChildrenDone as dagAllChildrenDone,
  getReadyIssues as dagGetReadyIssues,
  getUnblockedByCompletion as dagGetUnblockedByCompletion,
  getUnresolvedBlockers as dagGetUnresolvedBlockers,
  detectCycles,
} from "../domain/dag"
import type { DagCache, DagNode, DagNodeStatus, Issue } from "../domain/models"
import { logger } from "../observability/logger"

export class DagScheduler {
  private cache: DagCache = { version: 1, updatedAt: "", nodes: {} }
  private writeQueue: Promise<void> = Promise.resolve()
  /**
   * Optional callback invoked once per buildFromIssues() call that detects
   * at least one cycle. Wired by the Orchestrator to increment
   * `av_dag_cycles_total`. Exceptions thrown by the callback are
   * swallowed so the DAG build path is unaffected.
   */
  private onCycleDetected: (() => void) | null = null

  constructor(private cachePath: string) {}

  /** Register a one-line observability callback. Calling again replaces it. */
  setCycleObserver(fn: () => void): void {
    this.onCycleDetected = fn
  }

  // ── Construction ──────────────────────────────────────────────────

  buildFromIssues(issues: Issue[]): void {
    const nodes: Record<string, DagNode> = {}

    // Create nodes
    for (const issue of issues) {
      nodes[issue.id] = {
        issueId: issue.id,
        identifier: issue.identifier,
        status: this.mapIssueStatus(issue),
        parentId: issue.parentId,
        children: issue.children,
        blockedBy: [],
        blocks: [],
      }
    }

    // Build edges from relations
    for (const issue of issues) {
      const issueNode = nodes[issue.id]
      if (!issueNode) continue
      for (const rel of issue.relations) {
        const relatedNode = nodes[rel.relatedIssueId]
        if (!relatedNode) continue
        if (rel.type === "blocked_by") {
          issueNode.blockedBy.push(rel.relatedIssueId)
          relatedNode.blocks.push(issue.id)
        } else if (rel.type === "blocks") {
          issueNode.blocks.push(rel.relatedIssueId)
          relatedNode.blockedBy.push(issue.id)
        }
      }
    }

    // Deduplicate edges
    for (const node of Object.values(nodes)) {
      node.blockedBy = [...new Set(node.blockedBy)]
      node.blocks = [...new Set(node.blocks)]
    }

    // Detect cycles
    const cycles = detectCycles(nodes)
    if (cycles.length > 0) {
      logger.warn("dag-scheduler", "Cycle detected in dependency graph, ignoring cyclic edges", {
        cycles: JSON.stringify(cycles),
      })
      if (this.onCycleDetected) {
        try {
          this.onCycleDetected()
        } catch {
          /* observability must never break DAG building */
        }
      }
      // Remove cyclic edges — for simplicity, remove all blockedBy edges for nodes in cycles
      for (const cycle of cycles) {
        const cycleSet = new Set(cycle)
        for (const id of cycle) {
          const node = nodes[id]
          if (!node) continue
          node.blockedBy = node.blockedBy.filter((bid) => !cycleSet.has(bid))
          node.blocks = node.blocks.filter((bid) => !cycleSet.has(bid))
        }
      }
    }

    this.cache = { version: 1, updatedAt: new Date().toISOString(), nodes }
  }

  private mapIssueStatus(issue: Issue): DagNodeStatus {
    const name = issue.status.name.toLowerCase()
    if (name.includes("done") || name.includes("completed")) return "done"
    if (name.includes("cancel")) return "cancelled"
    if (name.includes("progress") || name.includes("started")) return "running"
    return "waiting"
  }

  // ── Queries ───────────────────────────────────────────────────────

  getUnresolvedBlockers(issueId: string): string[] {
    return dagGetUnresolvedBlockers(this.cache.nodes, issueId)
  }

  getReadyIssues(): string[] {
    return dagGetReadyIssues(this.cache.nodes)
  }

  getUnblockedByCompletion(issueId: string): string[] {
    return dagGetUnblockedByCompletion(this.cache.nodes, issueId)
  }

  allChildrenDone(parentId: string): boolean {
    return dagAllChildrenDone(this.cache.nodes, parentId)
  }

  getBlockedIssues(issueId: string): DagNode[] {
    const node = this.cache.nodes[issueId]
    if (!node) return []
    return node.blocks.map((id) => this.cache.nodes[id]).filter((n): n is DagNode => n !== undefined)
  }

  getChildrenSummaries(parentId: string): DagNode[] {
    const parent = this.cache.nodes[parentId]
    if (!parent) return []
    return parent.children.map((id) => this.cache.nodes[id]).filter((n): n is DagNode => n !== undefined)
  }

  getNode(issueId: string): DagNode | undefined {
    return this.cache.nodes[issueId]
  }

  hasNode(issueId: string): boolean {
    return issueId in this.cache.nodes
  }

  // ── Mutations ─────────────────────────────────────────────────────

  updateNodeStatus(issueId: string, status: DagNodeStatus): void {
    const node = this.cache.nodes[issueId]
    if (node) {
      node.status = status
      this.persistAsync()
    }
  }

  addRelation(issueId: string, relatedId: string, type: string): void {
    const issueNode = this.cache.nodes[issueId]
    const relatedNode = this.cache.nodes[relatedId]
    if (!issueNode || !relatedNode) return

    if (type === "blocks") {
      if (!issueNode.blocks.includes(relatedId)) issueNode.blocks.push(relatedId)
      if (!relatedNode.blockedBy.includes(issueId)) relatedNode.blockedBy.push(issueId)
    } else if (type === "blocked-by") {
      if (!issueNode.blockedBy.includes(relatedId)) issueNode.blockedBy.push(relatedId)
      if (!relatedNode.blocks.includes(issueId)) relatedNode.blocks.push(issueId)
    }
    this.persistAsync()
  }

  removeRelation(issueId: string, relatedId: string): void {
    const issueNode = this.cache.nodes[issueId]
    const relatedNode = this.cache.nodes[relatedId]

    if (issueNode) {
      issueNode.blockedBy = issueNode.blockedBy.filter((id) => id !== relatedId)
      issueNode.blocks = issueNode.blocks.filter((id) => id !== relatedId)
    }
    if (relatedNode) {
      relatedNode.blockedBy = relatedNode.blockedBy.filter((id) => id !== issueId)
      relatedNode.blocks = relatedNode.blocks.filter((id) => id !== issueId)
    }
    this.persistAsync()
  }

  addNode(issue: Issue): void {
    if (this.cache.nodes[issue.id]) return
    this.cache.nodes[issue.id] = {
      issueId: issue.id,
      identifier: issue.identifier,
      status: this.mapIssueStatus(issue),
      parentId: issue.parentId,
      children: issue.children,
      blockedBy: [],
      blocks: [],
    }
    this.persistAsync()
  }

  removeNode(issueId: string): void {
    const node = this.cache.nodes[issueId]
    if (!node) return

    // Clean up references from other nodes
    for (const blockerId of node.blockedBy) {
      const blocker = this.cache.nodes[blockerId]
      if (blocker) blocker.blocks = blocker.blocks.filter((id) => id !== issueId)
    }
    for (const blockedId of node.blocks) {
      const blocked = this.cache.nodes[blockedId]
      if (blocked) blocked.blockedBy = blocked.blockedBy.filter((id) => id !== issueId)
    }
    // Clean up parent reference
    if (node.parentId) {
      const parent = this.cache.nodes[node.parentId]
      if (parent) parent.children = parent.children.filter((id) => id !== issueId)
    }

    delete this.cache.nodes[issueId]
    this.persistAsync()
  }

  // ── Persistence ───────────────────────────────────────────────────

  async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, "utf-8")
      this.cache = JSON.parse(raw) as DagCache
      logger.info("dag-scheduler", `Loaded DAG cache with ${Object.keys(this.cache.nodes).length} nodes`)
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.cache = { version: 1, updatedAt: "", nodes: {} }
    }
  }

  async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true })
      this.cache.updatedAt = new Date().toISOString()
      await writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), "utf-8")
    } catch (err) {
      logger.error("dag-scheduler", "Failed to save DAG cache", { error: String(err) })
    }
  }

  /** Startup sync: rebuild DAG from Linear data, overwriting stale cache. */
  async reconcileWithLinear(issues: Issue[]): Promise<void> {
    this.buildFromIssues(issues)
    await this.saveCache()
    logger.info(
      "dag-scheduler",
      `DAG reconciled with ${issues.length} issues, ${Object.keys(this.cache.nodes).length} nodes`,
    )
  }

  /** Fire-and-forget persist through serialized write queue. */
  private persistAsync(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.saveCache())
      .catch((err) => {
        logger.error("dag-scheduler", "Async persist failed", { error: String(err) })
      })
  }
}
