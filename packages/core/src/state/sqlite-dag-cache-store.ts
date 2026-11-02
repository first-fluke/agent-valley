/**
 * SqliteDagCacheStore — DagCachePort over the state database. One row per
 * node; list fields are JSON arrays. A save replaces the whole graph in
 * one transaction.
 */

import type { DagCache, DagNode, DagNodeStatus } from "../domain/models"
import { type DagCachePort, JsonDagCacheStore } from "../orchestrator/persistence/dag-cache-store"
import { importLegacySnapshot } from "./legacy-json"
import type { StateDatabase } from "./state-database"

const UPDATED_AT = "dag_updated_at"

export class SqliteDagCacheStore implements DagCachePort {
  constructor(
    private readonly db: StateDatabase,
    /** `dag-cache.json` of earlier builds; imported once, then renamed. */
    private readonly legacyPath?: string,
  ) {}

  async load(): Promise<DagCache | null> {
    await importLegacySnapshot(this.db, "dag_cache", this.legacyPath, async () => {
      if (!this.legacyPath) return
      const legacy = await new JsonDagCacheStore(this.legacyPath).load()
      if (legacy?.nodes) await this.save(legacy)
    })

    const [result, updatedAt] = await Promise.all([
      this.db.execute({ sql: "SELECT * FROM dag_nodes", args: [] }),
      this.db.getMeta(UPDATED_AT),
    ])
    if (result.rows.length === 0 && updatedAt === null) return null
    const nodes: Record<string, DagNode> = {}
    for (const row of result.rows) {
      const issueId = String(row.issue_id)
      nodes[issueId] = {
        issueId,
        identifier: String(row.identifier),
        status: String(row.status) as DagNodeStatus,
        parentId: row.parent_id == null ? null : String(row.parent_id),
        children: parseIds(row.children),
        blockedBy: parseIds(row.blocked_by),
        blocks: parseIds(row.blocks),
      }
    }
    return { version: 1, updatedAt: updatedAt ?? "", nodes }
  }

  async save(cache: DagCache): Promise<void> {
    await this.db.write([
      { sql: "DELETE FROM dag_nodes", args: [] },
      ...Object.values(cache.nodes).map((node) => ({
        sql: `INSERT INTO dag_nodes (issue_id, identifier, status, parent_id, children, blocked_by, blocks)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          node.issueId,
          node.identifier,
          node.status,
          node.parentId,
          JSON.stringify(node.children),
          JSON.stringify(node.blockedBy),
          JSON.stringify(node.blocks),
        ],
      })),
      this.db.setMetaStatement(UPDATED_AT, cache.updatedAt || new Date().toISOString()),
    ])
  }
}

function parseIds(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
