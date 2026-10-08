import { uiMessage } from '../messages.js';
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { transaction } from '../db.js';
import { ApiError, isUuid, route } from '../http-common.js';
import type { ServerContext } from '../server-context.js';
import { parseAdbPublicKey } from '../adb-wire.js';
import { generateAdbKeyPair } from '../adb-key.js';
import { allocateAdbPortAccess, type AdbKeyRecord } from '../adb-access.js';
import type { AdbPortBroker } from '../adb-port.js';
import { selectedAdbKey } from '../user-adb-keys.js';

const LEASE_MS = 60 * 60_000;
const MAX_UPLOADED_KEYS = 20;

function adbKeyName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 ||
      /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'invalid_adb_key_name', uiMessage('ui.31a629668265', {}, 'en'));
  }
  return value.trim();
}

function privateKeyResponse(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function registerAdbPortRoutes(app: Express, context: ServerContext, broker: AdbPortBroker): void {
  const { pool, config, requireAuth, current, ownedSession } = context;

  app.get('/api/me/adb-public-keys', requireAuth, route(async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT id,name,fingerprint,created_at FROM user_adb_public_keys WHERE owner_user_id=$1 ORDER BY created_at DESC,id',
      [current(res).user.id],
    );
    res.json({ keys: rows.map(row => ({
      id: String(row.id), name: String(row.name), fingerprint: String(row.fingerprint),
      createdAt: new Date(row.created_at).toISOString(),
    })) });
  }));

  app.post('/api/me/adb-public-keys', requireAuth, route(async (req, res) => {
    const userId = current(res).user.id;
    const name = adbKeyName(req.body?.name);
    const publicKey = req.body?.publicKey;
    let fingerprint: string;
    try { fingerprint = parseAdbPublicKey(publicKey).fingerprint; }
    catch { throw new ApiError(400, 'invalid_adb_key', uiMessage('ui.27eda74bd795', {}, 'en')); }
    const key = await transaction(pool, async client => {
      // Serialize account uploads so the per-user limit cannot be bypassed by parallel requests.
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const count = await client.query(
        'SELECT count(*)::integer AS total FROM user_adb_public_keys WHERE owner_user_id=$1', [userId],
      );
      if (Number(count.rows[0].total) >= MAX_UPLOADED_KEYS) {
        throw new ApiError(409, 'adb_key_limit', uiMessage('ui.3571e58c9c31', {}, 'en'));
      }
      const duplicate = await client.query(
        'SELECT 1 FROM user_adb_public_keys WHERE owner_user_id=$1 AND fingerprint=$2 UNION ALL ' +
        'SELECT 1 FROM user_adb_keys WHERE user_id=$1 AND fingerprint=$2 LIMIT 1',
        [userId, fingerprint],
      );
      if (duplicate.rows[0]) throw new ApiError(409, 'adb_key_exists', uiMessage('ui.6c8b3a5453b4', {}, 'en'));
      const id = randomUUID();
      const inserted = await client.query(
        'INSERT INTO user_adb_public_keys(id,owner_user_id,name,public_key,fingerprint) ' +
        'VALUES($1,$2,$3,$4,$5) RETURNING created_at',
        [id, userId, name.trim(), String(publicKey).trim() + '\n', fingerprint],
      );
      return { id, name: name.trim(), fingerprint,
        createdAt: new Date(inserted.rows[0].created_at).toISOString() };
    });
    res.status(201).json({ key });
  }));

  app.patch('/api/me/adb-public-keys/:id', requireAuth, route(async (req, res) => {
    const id = req.params.id!;
    if (!isUuid(id)) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
    const name = adbKeyName(req.body?.name);
    const { rows } = await pool.query(
      'UPDATE user_adb_public_keys SET name=$3 WHERE id=$1 AND owner_user_id=$2 ' +
      'RETURNING id,name,fingerprint,created_at', [id, current(res).user.id, name],
    );
    if (!rows[0]) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
    res.json({ key: {
      id: String(rows[0].id), name: String(rows[0].name), fingerprint: String(rows[0].fingerprint),
      createdAt: new Date(rows[0].created_at).toISOString(),
    } });
  }));

  app.delete('/api/me/adb-public-keys/:id', requireAuth, route(async (req, res) => {
    const id = req.params.id!;
    if (!isUuid(id)) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
    await transaction(pool, async client => {
      const key = await client.query(
        'SELECT id FROM user_adb_public_keys WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
        [id, current(res).user.id],
      );
      if (!key.rows[0]) throw new ApiError(404, 'adb_key_not_found', uiMessage('ui.ff67904614b1', {}, 'en'));
      const inUse = await client.query('SELECT 1 FROM sessions WHERE adb_key_id=$1 LIMIT 1', [id]);
      if (inUse.rows[0]) {
        throw new ApiError(409, 'adb_key_in_use', uiMessage('ui.7f3fa36ddc8a', {}, 'en'));
      }
      await client.query('DELETE FROM user_adb_public_keys WHERE id=$1', [id]);
    });
    res.json({ ok: true });
  }));

  app.get('/api/me/adb-key', requireAuth, route(async (_req, res) => {
    privateKeyResponse(res);
    const { rows } = await pool.query(
      'SELECT fingerprint,created_at FROM user_adb_keys WHERE user_id=$1',
      [current(res).user.id],
    );
    res.json({ key: rows[0] ? {
      fingerprint: rows[0].fingerprint, createdAt: new Date(rows[0].created_at).toISOString(),
    } : null });
  }));

  app.post('/api/me/adb-key', requireAuth, route(async (_req, res) => {
    privateKeyResponse(res);
    const pair = await generateAdbKeyPair();
    const { rows } = await pool.query(
      'INSERT INTO user_adb_keys(user_id,public_key,fingerprint) VALUES($1,$2,$3) ' +
      'ON CONFLICT(user_id) DO NOTHING RETURNING created_at',
      [current(res).user.id, pair.publicKey, pair.fingerprint],
    );
    if (!rows[0]) throw new ApiError(409, 'adb_key_exists', uiMessage('ui.b5ea8fc4c4c9', {}, 'en'));
    res.status(201).json({
      ...pair, createdAt: new Date(rows[0].created_at).toISOString(),
    });
  }));

  app.post('/api/me/adb-key/rotate', requireAuth, route(async (_req, res) => {
    privateKeyResponse(res);
    const userId = current(res).user.id;
    const pair = await generateAdbKeyPair();
    const result = await transaction(pool, async client => {
      const existing = await client.query(
        'SELECT public_key,fingerprint FROM user_adb_keys WHERE user_id=$1 FOR UPDATE', [userId],
      );
      if (!existing.rows[0]) throw new ApiError(404, 'adb_key_missing', uiMessage('ui.9c1d0cbbfb7c', {}, 'en'));
      await client.query('SELECT pg_advisory_xact_lock(1820481225)');
      const leases = await client.query(
        'DELETE FROM adb_port_access WHERE owner_user_id=$1 AND public_key=$2 AND fingerprint=$3 RETURNING session_id',
        [userId, existing.rows[0].public_key, existing.rows[0].fingerprint],
      );
      const updated = await client.query(
        'UPDATE user_adb_keys SET public_key=$2,fingerprint=$3,created_at=now() ' +
        'WHERE user_id=$1 RETURNING created_at',
        [userId, pair.publicKey, pair.fingerprint],
      );
      return { sessions: leases.rows.map(row => String(row.session_id)), createdAt: new Date(updated.rows[0].created_at).toISOString() };
    });
    for (const sessionId of result.sessions) broker.closeSession(sessionId);
    res.status(201).json({ ...pair, createdAt: result.createdAt });
  }));

  app.get('/api/sessions/:id/adb-port-access', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res));
    if (!config.adbPorts) throw new ApiError(503, 'adb_port_disabled', uiMessage('ui.c617b1f2321a', {}, 'en'));
    const result = await pool.query(
      'SELECT port,expires_at,fingerprint,owner_user_id FROM adb_port_access WHERE session_id=$1 ' +
      'AND (expires_at IS NULL OR expires_at>now())',
      [session.id],
    );
    const access = result.rows[0];
    res.json({ access: access && access.owner_user_id === current(res).user.id
      ? { sessionId: session.id, host: config.adbPorts.host, port: access.port,
          expiresAt: access.expires_at ? new Date(access.expires_at).toISOString() : null,
          fingerprint: access.fingerprint }
      : null });
  }));

  app.post('/api/sessions/:id/adb-port-access', requireAuth, route(async (req, res) => {
    const userId = current(res).user.id;
    const session = await ownedSession(req.params.id!, current(res), true);
    if (session.state !== 'running') throw new ApiError(409, 'session_not_ready', uiMessage('ui.b9683f8115fc', {}, 'en'));
    if (!config.adbPorts) throw new ApiError(503, 'adb_port_disabled', uiMessage('ui.c617b1f2321a', {}, 'en'));
    const manualKey = req.body?.publicKey;
    let key: AdbKeyRecord | null = null;
    let expiresAt: Date | null = null;
    if (manualKey !== undefined) {
      try {
        const parsed = parseAdbPublicKey(manualKey);
        key = { public_key: String(manualKey).trim(), fingerprint: parsed.fingerprint };
      } catch {
        throw new ApiError(400, 'invalid_adb_key', uiMessage('ui.27eda74bd795', {}, 'en'));
      }
      expiresAt = new Date(Date.now() + LEASE_MS);
    }
    const access = await transaction(pool, async client => {
      let selected = key;
      if (!selected) {
        selected = await selectedAdbKey(client, userId,
          userId === session.ownerId ? session.adbKeyId : null);
      }
      if (!selected) throw new ApiError(409, 'adb_key_missing', uiMessage('ui.f044c42f837f', {}, 'en'));
      const lease = await allocateAdbPortAccess(client, config, session.id, userId, selected, expiresAt);
      return { ...lease, fingerprint: selected.fingerprint };
    });
    if (access.changed) broker.closeSession(session.id);
    res.status(201).json({
      sessionId: session.id, host: config.adbPorts.host, port: access.port,
      expiresAt: access.expiresAt?.toISOString() || null, fingerprint: access.fingerprint,
    });
  }));

  app.delete('/api/sessions/:id/adb-port-access', requireAuth, route(async (req, res) => {
    const session = await ownedSession(req.params.id!, current(res));
    await pool.query('DELETE FROM adb_port_access WHERE session_id=$1', [session.id]);
    broker.closeSession(session.id);
    res.json({ ok: true });
  }));
}