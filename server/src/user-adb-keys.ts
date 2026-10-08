import { uiMessage } from './messages.js';
import type { PoolClient } from 'pg';
import { ApiError, isUuid } from './http-common.js';
import type { AdbKeyRecord } from './adb-access.js';

type QueryClient = Pick<PoolClient, 'query'>;

export function parseSessionAdbKeyId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ApiError(400, 'invalid_adb_key_id', uiMessage('ui.6be67c8d4318', {}, 'en'));
  }
  return value;
}

export async function selectedAdbKey(
  client: QueryClient, userId: string, adbKeyId: string | null,
): Promise<AdbKeyRecord | null> {
  if (adbKeyId) {
    const found = await client.query(
      'SELECT public_key,fingerprint FROM user_adb_public_keys WHERE id=$1 AND owner_user_id=$2 FOR SHARE',
      [adbKeyId, userId],
    );
    if (!found.rows[0]) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
    return found.rows[0] as AdbKeyRecord;
  }
  const saved = await client.query(
    'SELECT public_key,fingerprint FROM user_adb_keys WHERE user_id=$1 FOR SHARE',
    [userId],
  );
  return (saved.rows[0] as AdbKeyRecord | undefined) || null;
}
