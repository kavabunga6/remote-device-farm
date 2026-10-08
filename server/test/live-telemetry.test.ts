import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import { ApplicationLog } from '../src/application-log.js';
import { connectServiceLog } from '../src/service-log.js';
import { AgentHub } from '../src/agent.js';
import { hostJson } from '../src/http-common.js';
import { cleanLiveTelemetry } from '../src/live-telemetry.js';

test('telemetry allowlist preserves measured zeroes and version metadata', () => {
  assert.deepEqual(cleanLiveTelemetry({ cpuUsagePercent: 0, cpuSampleSeconds: 10, agentVersion: '0.1.0', agentBuild: 'abcdef123456', metricsSampledAt: '2026-10-03T12:00:00.000Z', gpuTelemetry: [{ index: 0, utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 12288, injected: 'drop' }], arbitrary: 'drop' }), {
    cpuUsagePercent: 0, cpuSampleSeconds: 10, agentVersion: '0.1.0', agentBuild: 'abcdef123456', metricsSampledAt: '2026-10-03T12:00:00.000Z', gpuTelemetry: [{ index: 0, utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 12288 }],
  });
});

test('invalid or missing telemetry never becomes a healthy zero reading', () => {
  assert.deepEqual(cleanLiveTelemetry({}), {});
  assert.deepEqual(cleanLiveTelemetry({ cpuUsagePercent: NaN, cpuSampleSeconds: -1, agentVersion: 'secret\n', agentBuild: 'token', metricsSampledAt: 'invalid', gpuTelemetry: [{ index: 0, utilizationPercent: '0', memoryUsedMb: null, memoryTotalMb: Infinity }] }), {});
  assert.deepEqual(cleanLiveTelemetry({ cpuUsagePercent: 101, cpuSampleSeconds: 0, gpuTelemetry: [{ index: 0, utilizationPercent: -1, memoryUsedMb: 200, memoryTotalMb: 100 }] }), {});
});

test('GPU count, index, duplicate rows and numeric bounds are enforced', () => {
  assert.deepEqual(cleanLiveTelemetry({ gpuTelemetry: Array.from({ length: 17 }, (_, index) => ({ index, utilizationPercent: 1 })) }), {});
  assert.deepEqual(cleanLiveTelemetry({ gpuTelemetry: [null, [], { index: -1, utilizationPercent: 10 }, { index: 0, utilizationPercent: 20 }, { index: 0, utilizationPercent: 40 }, { index: 1, memoryTotalMb: 24576 }] }), { gpuTelemetry: [{ index: 0, utilizationPercent: 20 }, { index: 1, memoryTotalMb: 24576 }] });
});


test('agent hello and heartbeat retain live telemetry through database and host API mapping', async () => {
  const db = new PGlite();
  try {
    for (const version of ['001_init', '005_host_settings', '011_node_management']) await db.exec(await readFile(new URL('../migrations/' + version + '.sql', import.meta.url), 'utf8'));
    const client = { query: db.query.bind(db), release: () => {} };
    const pool = { connect: async () => client, query: db.query.bind(db) } as unknown as Pool;
    const logs = new ApplicationLog(); const off = connectServiceLog(pool, logs);
    const hub = new AgentHub(pool);
    const receive = hub as unknown as { agentClosed(link: unknown): Promise<void>; onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: (link: unknown) => void): Promise<void> };
    const socket = { readyState: 1, send: () => {}, close: () => {}, terminate: () => {} } as unknown as WebSocket;
    let link: unknown;
    await receive.onAgentMessage(socket, 'metrics-node', { type: 'hello', hostId: 'metrics-node', slots: 1, metrics: { cpuCores: 8, agentVersion: '0.1.0' }, activeSessions: [] }, value => { link = value; });
    assert.match(logs.tail().records[0]!.message, /agent.connected host=metrics-node/);
    const sample = { cpuUsagePercent: 33.3, cpuSampleSeconds: 10, agentVersion: '0.1.0', gpuTelemetry: [{ index: 0, utilizationPercent: 75, memoryUsedMb: 2048, memoryTotalMb: 12288 }], metricsSampledAt: '2026-10-03T12:00:00.000Z' };
    await receive.onAgentMessage(socket, 'metrics-node', { type: 'heartbeat', hostId: 'metrics-node', slots: 1, metrics: { ...sample, arbitrary: 'discard' }, activeSessions: [] }, () => {});
    const row = (await db.query<Record<string, unknown>>("SELECT * FROM hosts WHERE id='metrics-node'")).rows[0]!;
    assert.deepEqual(hostJson(row).metrics, sample);
    await receive.onAgentMessage(socket, 'metrics-node', { type: 'heartbeat', hostId: 'metrics-node', slots: 1, metrics: { agentVersion: '0.1.0' }, activeSessions: [] }, () => {});
    const next = (await db.query<Record<string, unknown>>("SELECT * FROM hosts WHERE id='metrics-node'")).rows[0]!;
    assert.deepEqual(hostJson(next).metrics, { agentVersion: '0.1.0' });
    assert.equal(logs.tail().records.length, 1, 'normal heartbeats do not fill the runtime tail');
    await receive.agentClosed(link);
    assert.match(logs.tail().records.at(-1)!.message, /agent.disconnected host=metrics-node/);
    assert.equal(logs.tail().records.at(-1)!.level, 'warning');
    off(); await hub.dispose();
  } finally { await db.close(); }
});
