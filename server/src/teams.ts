import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;
type Actor = { id: string; role: string };

// Most generous limit across the user's teams. null team limit = global default, 0 = unlimited.
export function combineLimits(teamLimits: Array<number | null>, fallback: number): number {
  if (!teamLimits.length) return fallback;
  const values = teamLimits.map(value => value == null ? fallback : value);
  return values.includes(0) ? 0 : Math.max(...values);
}

// Union of allowlists; null means every profile. Any team with an empty list opens everything.
export function combineAllowlists(lists: string[][]): string[] | null {
  if (!lists.length || lists.some(list => !list.length)) return null;
  return [...new Set(lists.flat())];
}

export async function teamLimitFor(client: Queryable, user: Actor, fallback: number): Promise<number> {
  if (user.role === 'admin') return 0;
  const { rows } = await client.query(
    `SELECT t.max_sessions FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1`, [user.id]);
  return combineLimits(rows.map(row => row.max_sessions == null ? null : Number(row.max_sessions)), fallback);
}

export async function allowedProfileIds(client: Queryable, user: Actor): Promise<string[] | null> {
  if (user.role === 'admin') return null;
  const { rows } = await client.query(
    `SELECT m.team_id, COALESCE(array_agg(tp.profile_id) FILTER (WHERE tp.profile_id IS NOT NULL), '{}') AS profiles
     FROM team_members m LEFT JOIN team_profiles tp ON tp.team_id=m.team_id
     WHERE m.user_id=$1 GROUP BY m.team_id`, [user.id]);
  return combineAllowlists(rows.map(row => row.profiles as string[]));
}
