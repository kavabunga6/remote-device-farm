import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AgentHub } from '../src/agent.js';
import { migrate } from '../src/db.js';
import { ImagePrewarmWorker, registerImagePrewarmRoutes } from '../src/image-prewarm.js';
import type { ServerContext } from '../src/server-context.js';
import { ApiError } from '../src/http-common.js';

const A = 'farm.example/rdf-emulator:a@sha256:' + 'a'.repeat(64);
const B = 'farm.example/rdf-emulator:b@sha256:' + 'b'.repeat(64);
async function fixture() {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values === undefined ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rowCount: result?.rows?.length || result?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await migrate(pool);
  await db.exec("UPDATE profiles SET enabled=false; INSERT INTO hosts(id,name,slots) VALUES('a','A',1),('b','B',1),('c','C',1)");
  await db.query(`INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,disk_gb) VALUES('test-a','A','14',$1,4,6144,8),('test-b','B','14',$2,4,6144,8)`, [A,B]);
  const calls: Array<{ host: string; image: string }> = [];
  const online = new Set(['a', 'b', 'c']);
  let command: () => Promise<Record<string, unknown> | void> = async () => {};
  const hub = { hasAgent: (id: string) => online.has(id), command: async (host: string, session: string, action: string, params: { image: string }, timeout: number) => {
    assert.equal(host,session); assert.equal(action,'image-prewarm'); assert.equal(timeout,30*60_000);
    calls.push({host,image:params.image}); const result = await command(); return result ?? {ready:true,image:params.image};
  } } as unknown as AgentHub;
  const worker = new ImagePrewarmWorker(pool,hub);
  return { db, pool, hub, worker, online, calls, setCommand: (fn: typeof command) => { command=fn; },
    close: async () => { await worker.stop(); await db.close(); } };
}

test('prewarm persists requests, deduplicates images and bounds work to two nodes with one pull per node', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.worker.enqueue(),{queued:6,skipped:0});
    assert.deepEqual(await f.worker.enqueue(),{queued:0,skipped:0});
    let release!: () => void;
    f.setCommand(() => new Promise<void>(resolve => { release=resolve; }));
    // Use the same promise for both concurrent downloads.
    const gate = new Promise<void>(resolve => { release=resolve; }); f.setCommand(() => gate);
    await f.worker.poll(); await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(f.calls.length,2); assert.equal(new Set(f.calls.map(call=>call.host)).size,2);
    await f.worker.poll(); assert.equal(f.calls.length,2);
    release(); await f.worker.drain();
    assert.equal((await f.db.query("SELECT * FROM image_prewarm_jobs WHERE state='done'")).rows.length,2);
    f.setCommand(async () => {});
    for (let i=0;i<4;i++) { await f.worker.poll(); await f.worker.drain(); }
    assert.equal((await f.db.query("SELECT * FROM image_prewarm_jobs WHERE state='done'")).rows.length,6);
  } finally { await f.close(); }
});

test('offline work survives a new worker; expired leases retry, active leases do not duplicate', async () => {
  const f = await fixture();
  try {
    f.online.clear(); await f.worker.enqueue(['a'],['test-a']); await f.worker.poll(); assert.equal(f.calls.length,0);
    const second = new ImagePrewarmWorker(f.pool,f.hub); f.online.add('a');
    await f.db.query("UPDATE image_prewarm_jobs SET state='pulling',worker_id='00000000-0000-4000-8000-000000000001',lease_until=now()+interval '1 minute'");
    await second.poll(); assert.equal(f.calls.length,0);
    await f.db.query("UPDATE image_prewarm_jobs SET lease_until=now()-interval '1 second'");
    await second.poll(); await second.drain(); assert.equal(f.calls.length,1);
    assert.equal((await second.list() as Array<{state:string}>)[0]?.state,'done'); await second.stop();
  } finally { await f.close(); }
});

test('invalid selections roll back, ABI and mutable tags are skipped, failed downloads expose no credentials', async () => {
  const f=await fixture();
  try {
    await assert.rejects(f.worker.enqueue(['missing']),/existing enabled nodes/);
    assert.equal((await f.worker.list()).length,0);
    await f.db.query("UPDATE profiles SET image='mutable:latest' WHERE id='test-b'");
    await f.db.query("UPDATE profiles SET abi='arm64-v8a' WHERE id='test-a'");
    await f.db.query(`UPDATE hosts SET metrics='{"architecture":"x64"}' WHERE id='a'`);
    assert.deepEqual(await f.worker.enqueue(['a']),{queued:0,skipped:2});
    f.setCommand(async()=>{throw new Error('password=never-show-this');});
    await f.worker.enqueue(['b'],['test-a']); await f.worker.poll(); await f.worker.drain();
    const status=JSON.stringify(await f.worker.list()); assert.ok(status.includes('failed')); assert.ok(!status.includes('never-show-this'));
    assert.deepEqual(await f.worker.enqueue(['b'],['test-a']),{queued:1,skipped:0});
    await f.db.query("UPDATE profiles SET enabled=false WHERE id='test-a'"); await f.worker.poll();
    assert.equal(f.calls.length,1,'disabled profile is not downloaded');
  } finally { await f.close(); }
});

test('prewarm endpoints are admin-only and reject arbitrary images and empty selectors', async () => {
  const f=await fixture(); const app=express(); app.use(express.json()); let admin=false;
  registerImagePrewarmRoutes(app,{pool:f.pool,requireAuth:(_req,res,next)=>{next();},
    requireAdmin:(_req,res,next)=>{if(!admin){res.sendStatus(403);return;}next();},current:()=>({user:null})} as unknown as ServerContext,f.worker);
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof ApiError?error.status:500).json({error:String(error)}));
  const server=createServer(app); server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); assert.ok(address&&typeof address!=='string');
  const request=(method:string,body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/admin/emulator-images/prewarm`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    assert.equal((await request('GET')).status,403); assert.equal((await request('POST',{})).status,403); admin=true;
    assert.equal((await request('POST',{image:'evil:latest'})).status,400); assert.equal((await request('POST',{hostIds:[]})).status,400);
    const response=await request('POST',{hostIds:['a'],profileIds:['test-a']}); assert.equal(response.status,202); assert.deepEqual(await response.json(),{queued:1,skipped:0});
    const rows=await(await request('GET')).json() as {items:unknown[]}; assert.equal(rows.items.length,1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await f.close(); }
});

test('unverified stock starter is pinned but unavailable after migrations',async()=>{
  const f=await fixture();try {
    const result=await f.db.query<{image:string;enabled:boolean;recommended:boolean}>("SELECT image,enabled,recommended FROM profiles WHERE id='android-30'");
    assert.equal(result.rows[0]?.image,'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2@sha256:e78ac1816acef59e40285e90003acd490ef54bb3242ed088afa31bc982577050');
    assert.equal(result.rows[0]?.enabled,false);
    assert.equal(result.rows[0]?.recommended,false);
  }finally{await f.close();}
});


test('an expired lease re-claimed by the same worker cannot be completed by the old attempt', async () => {
  const f = await fixture();
  const releases: Array<() => void> = [];
  try {
    f.setCommand(() => new Promise<void>(resolve => releases.push(resolve)));
    await f.worker.enqueue(['a'], ['test-a']);
    await f.worker.poll();
    for (let i = 0; i < 100 && releases.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const first = (await f.db.query<{ worker_id: string }>('SELECT worker_id FROM image_prewarm_jobs')).rows[0]!.worker_id;
    await f.db.query("UPDATE image_prewarm_jobs SET lease_until=now()-interval '1 second'");
    await f.worker.poll();
    for (let i = 0; i < 100 && releases.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const second = (await f.db.query<{ worker_id: string }>('SELECT worker_id FROM image_prewarm_jobs')).rows[0]!.worker_id;
    assert.notEqual(first, second, 'every claim has its own identity');
    releases[0]!();
    await new Promise(resolve => setTimeout(resolve, 20));
    const pending = (await f.db.query<{ state: string; worker_id: string }>('SELECT state,worker_id FROM image_prewarm_jobs')).rows[0]!;
    assert.equal(pending.state, 'pulling');
    assert.equal(pending.worker_id, second);
    releases[1]!();
    await f.worker.drain();
    assert.equal((await f.worker.list() as Array<{ state: string }>)[0]!.state, 'done');
  } finally { for (const release of releases) release(); await f.close(); }
});

test('a resolved command is not success unless the node confirms readiness of the exact digest', async () => {
  const f = await fixture();
  try {
    for (const response of [{ok:true}, {ready:true,image:B}, {ready:false,image:A}]) {
      f.setCommand(async () => response);
      await f.worker.enqueue(['a'], ['test-a']);
      await f.worker.poll(); await f.worker.drain();
      assert.equal((await f.worker.list() as Array<{ state: string }>)[0]!.state, 'failed');
    }
  } finally { await f.close(); }
});
