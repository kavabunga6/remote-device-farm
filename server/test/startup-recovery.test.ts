import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type WebSocket from 'ws';
import { AgentHub } from '../src/agent.js';
import { launchSession as startSession } from '../src/session-create.js';
import { testPool } from './support/api-fixture.js';

const launches = new Map<Pool, Set<Promise<void>>>();
function launchSession(...args: Parameters<typeof startSession>) {
  const task = startSession(...args);
  const active = launches.get(args[0].pool) ?? new Set<Promise<void>>();
  launches.set(args[0].pool, active); active.add(task);
  void task.then(() => active.delete(task), () => active.delete(task));
  return task;
}

const ID = '55555555-5555-4555-8555-555555555555';
const USER = '44444444-4444-4444-8444-444444444444';
const HOST = 'host-1';
const ready = { sessionId: ID, containerId: 'container-1', preparing: false, bootReady: true, networkEnabled: false };
async function fixture() {
  const db = new PGlite();
  for (const file of ['001_init', '005_host_settings', '011_node_management', '012_session_lifecycle', '013_queue_notifications', '048_user_removal']) {
    await db.exec(await readFile(new URL('../migrations/' + file + '.sql', import.meta.url), 'utf8'));
  }
  await db.exec("CREATE TABLE service_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,occurred_at timestamptz DEFAULT now(), service text,severity text,code text,host_id text,session_id uuid,message text DEFAULT '')");
  await db.exec('ALTER TABLE sessions ADD COLUMN gpu_mode text; ALTER TABLE sessions ADD COLUMN startup_progress jsonb; ALTER TABLE sessions ADD COLUMN startup_deadline_at timestamptz');
  const pool = testPool(db);
  await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','owner','owner','Owner')", [USER]);
  await db.query("INSERT INTO hosts(id,name,slots) VALUES($1,'Host',1)", [HOST]);
  await db.query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state,startup_deadline_at) VALUES($1,$2,$3,'android-30','starting',now()+interval '15 minutes')", [ID, USER, HOST]);
  const hub = new AgentHub(pool);
  const sent: Array<Record<string, unknown>> = [];
  const socket = () => ({ readyState: 1, send: (text: string) => sent.push(JSON.parse(text)), close() {}, terminate() {} }) as unknown as WebSocket;
  const receive = (ws: WebSocket, message: Record<string, unknown>) => (hub as unknown as {
    onAgentMessage(ws: WebSocket, hostId: string, message: Record<string, unknown>, setLink: () => void): Promise<void>;
  }).onAgentMessage(ws, HOST, message, () => {});
  const announce = (ws: WebSocket, type: 'hello' | 'heartbeat', activeSessions: unknown[]) => receive(ws, {
    type, hostId: HOST, name: 'Host', slots: 1, metrics: {}, activeSessions,
  });
  const state = async () => (await pool.query<{ state: string; container_id: string | null; gpu_mode: string | null; startup_progress: { stage: string } | null }>('SELECT state,container_id,gpu_mode,startup_progress FROM sessions WHERE id=$1', [ID])).rows[0];
  const waitRunning = async () => {
    for (let i = 0; i < 50; i++) {
      const row = await state();
      if (row?.state === 'running' && row.startup_progress?.stage === 'ready') return row;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('session never became ready');
  };
  const waitStart = async () => {
    for (let i = 0; i < 100; i++) {
      const command = sent.find(message => message.action === 'start');
      if (command) return command;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('start was not scheduled');
  };
  return { db, pool, hub, sent, socket, receive, announce, state, waitRunning, waitStart,
    close: async () => { await hub.dispose(); await Promise.allSettled([...(launches.get(pool) ?? [])]); launches.delete(pool); await pool.end(); } };
}

for (const completedOn of ['hello', 'heartbeat'] as const) test('boot-verified ' + completedOn + ' completes the original start after agent restart', async () => {
  const f = await fixture();
  try {
    const original = f.socket(); await f.announce(original, 'hello', []);
    await f.db.query("UPDATE sessions SET gpu_mode='nvidia' WHERE id=$1", [ID]);
    const launch = { profile: { image: 'registry.example/android:1', gpuMode: 'nvidia', gpuBackend: 'cuda' } };
    launchSession({ pool: f.pool, hub: f.hub }, ID, HOST, launch, 60_000);
    const start = await f.waitStart();
    assert.deepEqual(start.params, launch);
    const restarted = f.socket();
    await f.announce(restarted, 'hello', completedOn === 'hello' ? [ready] : [{ ...ready, preparing: true, bootReady: false }]);
    if (completedOn === 'heartbeat') {
      assert.equal((await f.state()).state, 'starting');
      await f.announce(restarted, 'heartbeat', [ready]);
    }
    const row = await f.waitRunning(); assert.equal(row.container_id, 'container-1');
    assert.equal(row.gpu_mode, 'nvidia', 'reconnect keeps the original session GPU choice');
    assert.equal(f.sent.filter(message => message.action === 'start').length, 1, 'recovery does not relaunch or reselect the backend');
    await f.announce(restarted, 'heartbeat', [ready]);
    await f.receive(restarted, { type: 'result', id: start.id, ok: true, data: { containerId: 'container-1' } });
    assert.equal((await f.state()).state, 'running');
    assert.equal((await f.db.query("SELECT id FROM notifications WHERE session_id=$1 AND kind='session.ready'", [ID])).rows.length, 1, 'ready event is immediate and recovery cannot replay it');
    assert.equal(f.sent.some(message => message.action === 'kill'), false);
  } finally { await f.close(); }
});

test('a genuine reconnect or unverified container leaves the original start pending', async () => {
  const f = await fixture();
  try {
    const original = f.socket(); await f.announce(original, 'hello', []);
    launchSession({ pool: f.pool, hub: f.hub }, ID, HOST, {}, 60_000);
    const start = await f.waitStart();
    const reconnected = f.socket();
    await f.announce(reconnected, 'hello', [{ ...ready, preparing: true }]);
    for (const reported of [{ ...ready, bootReady: false }, { ...ready, bootReady: undefined }, { ...ready, containerId: '' }]) {
      await f.announce(reconnected, 'heartbeat', [reported]);
      assert.equal((await f.state()).state, 'starting');
    }
    await f.receive(reconnected, { type: 'result', id: start.id, ok: true, data: { containerId: 'container-1' } });
    await f.waitRunning();
    assert.equal(f.sent.some(message => message.action === 'kill'), false);
  } finally { await f.close(); }
});

test('late startup success preserves only the same already-running host and container', async () => {
  const f = await fixture();
  try {
    for (const [state, host, container, shouldKill] of [
      ['running', HOST, 'container-1', false],
      ['running', HOST, 'different-container', true],
      ['running', 'other-host', 'container-1', true],
      ['stopping', HOST, 'container-1', true],
    ] as const) {
      await f.pool.query("INSERT INTO hosts(id,name,slots) VALUES('other-host','Other',1) ON CONFLICT DO NOTHING");
      await f.pool.query("UPDATE sessions SET state='starting',host_id=$2,container_id=NULL WHERE id=$1", [ID, HOST]);
      const killed: string[] = [];
      let ready!: () => void, resolve!: (data: Record<string, unknown>) => void;
      const scheduled = new Promise<void>(r => { ready = r; });
      const result = new Promise<Record<string, unknown>>(r => { resolve = r; });
      const hub = { hasAgent: () => true, refreshStream: () => {},
        command: async (_host: string, _id: string, action: string) => {
          if (action === 'start') { ready(); return result; }
          if (action === 'kill') killed.push(_id);
          return {};
        } } as unknown as AgentHub;
      const launch = launchSession({ pool: f.pool, hub }, ID, HOST, {});
      await scheduled;
      await f.pool.query('UPDATE sessions SET state=$2,host_id=$3,container_id=$4 WHERE id=$1', [ID, state, host, container]);
      resolve({ containerId: 'container-1' });
      await launch;
      assert.equal(killed.length, shouldKill ? 1 : 0, state + ':' + host + ':' + container);
    }
  } finally { await f.close(); }
});


test('a reconnected viewer retries once when an already-running recovered Android finishes its boot probe', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE sessions SET state='running',container_id='container-1' WHERE id=$1", [ID]);
    const agent = f.socket();
    await f.announce(agent, 'hello', [{ ...ready, preparing: true, bootReady: false }]);
    const viewerMessages: Array<Record<string, unknown>> = [];
    const viewer = { readyState: 1, send: (message: string) => viewerMessages.push(JSON.parse(message)),
      on() {}, close() {}, terminate() {} } as unknown as WebSocket;
    f.hub.addViewer(ID, HOST, viewer);
    const first = f.sent.filter(message => message.action === 'stream-start'); assert.equal(first.length, 1);
    await f.receive(agent, { type: 'result', id: first[0].id, ok: false, error: 'Session is not running on this agent' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(viewer.readyState, 1);
    assert.ok(viewerMessages.some(message => message.type === 'error'));
    await f.announce(agent, 'heartbeat', [ready]);
    assert.equal(f.sent.filter(message => message.action === 'stream-start').length, 2);
    await f.announce(agent, 'heartbeat', [ready]);
    assert.equal(f.sent.filter(message => message.action === 'stream-start').length, 2);
    assert.equal((await f.state()).state, 'running');
  } finally { await f.close(); }
});


test('a failed launch retains ordered, redacted diagnostics after cleanup and rejects forged agent log bindings', async () => {
  const f=await fixture();
  try {
    const ws=f.socket();await f.announce(ws,'hello',[]);
    launchSession({pool:f.pool,hub:f.hub},ID,HOST,{profile:{image:'registry.example/android@sha256:'+'a'.repeat(64),cpu:4,memoryMb:6144,containerEnv:{PASSWORD:'opaque-secret'}}},60000);
    const start=await f.waitStart();
    const event={code:'container.stderr',message:'Vulkan init failed; password=private-value',severity:'error',service:'emulator'};
    await f.receive(ws,{type:'session-log',requestId:start.id,sessionId:USER,event});
    await f.receive(f.socket(),{type:'session-log',requestId:start.id,sessionId:ID,event});
    await f.receive(ws,{type:'startup-progress',requestId:start.id,sessionId:ID,progress:{stage:'booting'}});
    await f.receive(ws,{type:'session-log',requestId:start.id,sessionId:ID,event});
    await f.receive(ws,{type:'result',id:start.id,ok:false,error:'Container exited before boot; password=private-value'});
    let kill: Record<string,unknown>|undefined;
    for(let i=0;i<100;i++){kill=f.sent.find(m=>m.action==='kill');if(kill)break;await new Promise(r=>setTimeout(r,5));}
    assert.ok(kill,'failed launch must request cleanup');
    await f.receive(ws,{type:'session-log',requestId:kill.id,sessionId:ID,event:{code:'session.cleanup_complete',message:'Volumes and networks removed',severity:'info',service:'agent'}});
    await f.receive(ws,{type:'result',id:kill.id,ok:true,data:{stopped:true}});
    for(let i=0;i<100 && await f.state();i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(await f.state(),undefined);
    const rows=(await f.db.query<{code:string;message:string;session_id:string}>('SELECT * FROM service_logs WHERE session_id=$1 ORDER BY id',[ID])).rows;
    assert.equal(rows.filter(r=>r.code==='container.stderr').length,1,'forged bindings must be ignored');
    for(const code of ['session.start_requested','session.booting','container.stderr','session.start_failed','session.cleanup_complete','session.released'])assert.ok(rows.some(r=>r.code===code),code);
    assert.ok(rows.every(r=>r.session_id===ID));
    assert.ok(!JSON.stringify(rows).includes('private-value'));
    assert.ok(!JSON.stringify(rows).includes('opaque-secret'));
    assert.ok(rows.findIndex(r=>r.code==='container.stderr')<rows.findIndex(r=>r.code==='session.start_failed'));
    assert.ok(rows.findIndex(r=>r.code==='session.cleanup_complete')<rows.findIndex(r=>r.code==='session.released'));
    await f.db.exec('CREATE TABLE rental_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,session_id uuid,host_id text)');
    await f.db.query('INSERT INTO rental_history(session_id,host_id) VALUES($1,$2),($3,$4)',[ID,HOST,USER,'another-host']);
    await f.receive(ws,{type:'session-log',sessionId:ID,event:{...event,code:'session.recovery_cleanup',message:'Archived owned cleanup'}});
    await f.receive(ws,{type:'session-log',sessionId:USER,event:{...event,code:'session.recovery_cleanup',message:'Forbidden host cleanup'}});
    await f.announce(ws,'heartbeat',[]);
    const recovered=(await f.db.query<{message:string}>("SELECT message FROM service_logs WHERE code='session.recovery_cleanup'")).rows;
    assert.deepEqual(recovered.map(r=>r.message),['Archived owned cleanup']);
  } finally {await f.close();}
});
