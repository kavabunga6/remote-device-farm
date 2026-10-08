import type { Pool } from 'pg';

export interface AgentInventoryItem {
  hostId: string;
  createdAt: Date;
  name: string | null;
  status: string;
  lastSeenAt: Date | null;
  source: 'environment' | 'registered';
  canRevoke: boolean;
}

/** Include the configured bootstrap host without creating or disclosing credentials. */
export async function listAgentInventory(pool: Pick<Pool, 'query'>, bootstrapHostId: string): Promise<AgentInventoryItem[]> {
  const { rows } = await pool.query<AgentInventoryItem>(
    `WITH inventory AS (
       SELECT host_id FROM agent_credentials
       UNION
       SELECT id FROM hosts WHERE id=$1 AND removed_at IS NULL
     )
     SELECT i.host_id AS "hostId", COALESCE(c.created_at,h.created_at) AS "createdAt",
       COALESCE(h.display_name,h.name) AS name, COALESCE(h.status,'offline') AS status,
       h.last_seen_at AS "lastSeenAt",
       CASE WHEN i.host_id=$1 THEN 'environment' ELSE 'registered' END AS source,
       i.host_id<>$1 AS "canRevoke"
     FROM inventory i
     LEFT JOIN agent_credentials c ON c.host_id=i.host_id
     LEFT JOIN hosts h ON h.id=i.host_id
     WHERE h.removed_at IS NULL
     ORDER BY COALESCE(c.created_at,h.created_at) DESC, i.host_id`, [bootstrapHostId],
  );
  return rows;
}
