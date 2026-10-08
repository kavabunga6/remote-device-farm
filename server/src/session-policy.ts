import { uiMessage } from './messages.js';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './http-common.js';
import { allowedProfileIds, teamLimitFor } from './teams.js';

type Queryable = Pick<PoolClient, 'query'>;
type Actor = { id: string; role: string };

// How many sessions the user may hold at once; 0 means no limit. Teams adjust this per user.
export async function sessionLimitFor(client: Queryable, user: Actor, config: Pick<Config, 'maxSessionsPerUser'>): Promise<number> {
  return teamLimitFor(client, user, config.maxSessionsPerUser);
}

// Throws an ApiError when the user may not start this profile. Teams restrict profiles per team.
export async function assertProfileAllowed(client: Queryable, user: Actor, profileId: string): Promise<void> {
  const allowed = await allowedProfileIds(client, user);
  if (allowed && !allowed.includes(profileId)) {
    throw new ApiError(403, 'profile_not_allowed', uiMessage('ui.74ff2738b489', {}, 'en'));
  }
}
