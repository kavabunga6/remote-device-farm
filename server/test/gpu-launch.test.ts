import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { AgentHub } from '../src/agent.js';
import type { Config } from '../src/config.js';
import type { AuthService } from '../src/auth.js';
import { ApiError } from '../src/http-common.js';
import { hostGpuBackend } from '../src/gpu-modes.js';
import { parseRequestedGpuMode, resolveProfileLaunch } from '../src/profile-launch.js';
import { createServerContext } from '../src/server-context.js';
import { createSession } from '../src/session-create.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { registerQueueRoutes } from '../src/routes/queue-routes.js';
import { runQueuePass } from '../src/queue-dispatcher.js';

const CPU = { image: 'registry.example/android:30', gpu_support: 'none', memory_mb: 4096 };
const DUAL = { ...CPU, gpu_support: 'cuda', memory_mb: 6144 };
const DRI = { ...CPU, gpu_support: 'gpu' };

test('GPU backend comes from node capabilities and legacy profile values do not restrict either mode', () => {
  for (const profile of [CPU, DUAL, DRI]) {
    for (const gpuMode of ['software', 'nvidia'] as const) assert.deepEqual(resolveProfileLaunch(profile, gpuMode), { gpuMode, image: profile.image, memoryMb: profile.memory_mb });
    assert.equal(resolveProfileLaunch(profile).gpuMode, 'software');
  }
  for (const value of [true, false, null, 'host', 'software -gpu host', { image: 'untrusted' }]) assert.throws(() => parseRequestedGpuMode(value));
  assert.equal(hostGpuBackend({ gpuCapabilities: ['gpu', 'cuda'], nvidiaGpuAvailable: false }), 'cuda');
  assert.equal(hostGpuBackend({ gpuCapabilities: ['gpu'], nvidiaGpuAvailable: true }), 'gpu');
  assert.equal(hostGpuBackend({ gpuCapabilities: [], nvidiaGpuAvailable: true, driGpuAvailable: true }), null);
  assert.equal(hostGpuBackend({ gpuCapabilities: ['unknown'] }), null);
  assert.equal(hostGpuBackend({ nvidiaGpuAvailable: true }), 'cuda');
  assert.equal(hostGpuBackend({ driGpuAvailable: true }), 'gpu');
  assert.equal(hostGpuBackend({}), null);
  assert.equal(hostGpuBackend(null), null);
});

test('launch API keeps one image, matches node capabilities, and queue retains GPU mode', async () => {
  const db = new PGlite(); let server: ReturnType<typeof createServer> | null = null;
  const userId = '11111111-1111-4111-8111-111111111111';
  const launches: Array<{ id: string; host: string; profile: Record<string, unknown> }> = [];
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) await db.exec(await readFile(new URL(name,directory),'utf8'));
    await db.query('UPDATE launch_settings SET allow_launch_overrides=true');
    await db.query("INSERT INTO users(id,provider,subject,username,display_name) VALUES($1,'local','qa','qa','QA')",[userId]);
    await db.query("INSERT INTO hosts(id,name,slots,status,last_seen_at,manual_slots,slot_cpu,slot_memory_mb,metrics) VALUES('gpu','GPU',8,'online',now(),8,4,6144,'{\"nvidiaGpuAvailable\":true,\"gpuCapabilities\":[\"cuda\",\"gpu\"]}'),('gpu-small','GPU 4GB',8,'online',now(),8,4,4096,'{\"nvidiaGpuAvailable\":true,\"gpuCapabilities\":[\"cuda\",\"gpu\"]}'),('cpu','CPU',8,'online',now(),8,4,6144,'{\"gpuCapabilities\":[]}'),('dri','DRI',8,'online',now(),8,4,4096,'{\"gpuCapabilities\":[\"gpu\"]}')");
    for (const host of ['cpu','gpu','gpu-small','dri']) for(let slot=0;slot<8;slot++) await db.query('INSERT INTO host_slots(host_id,slot_index) VALUES($1,$2)',[host,slot]);
    for (const [id,profile] of [['dual',DUAL],['cpu-only',CPU],['dri',DRI]] as const) await db.query("INSERT INTO profiles(id,name,android_version,image,gpu_support,cpu,memory_mb,disk_gb) VALUES($1,$1,'11',$2,$3,2,$4,8)",[id,profile.image,profile.gpu_support,profile.memory_mb]);
    await db.query("UPDATE profiles SET disk_max_gb=32,sdcard_max_gb=4 WHERE id='dual'");
    const client = { query:db.query.bind(db),release:()=>{} };
    const pool = {query:db.query.bind(db),connect:async()=>client} as unknown as Pool;
    const auth = {authenticate:async()=>({user:{id:userId,username:'qa',displayName:'QA',role:'user',provider:'local'},via:'cookie'})} as unknown as AuthService;
    const hub = {hasAgent:()=>true,supportsNodePolicy:()=>true,onSessionClosed:()=>{},command:async(host:string,id:string,action:string,params:{profile:Record<string,unknown>})=>{
      if(action==='start') { launches.push({host,id,profile:params.profile}); return new Promise(()=>{}); }
      return {};
    }} as unknown as AgentHub;
    const config = {maxSessionsPerUser:0,idleTimeoutMinutes:0,maxSessionHours:0,queueTtlMinutes:30} as Config;
    const context = createServerContext(pool,config,auth,undefined,hub);
    const app=express();app.use(express.json());registerSessionRoutes(app,context);registerQueueRoutes(app,context,{startDispatcher:false});
    app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(error instanceof ApiError?error.status:500).json({error:{code:error instanceof ApiError?error.code:'internal',message:String(error)}});});
    server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
    const request=(route:string,body:unknown)=>fetch('http://127.0.0.1:'+address.port+'/api/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const start=async(body:unknown)=>{const result=await request('sessions',body);assert.equal(result.status,202,await result.clone().text());return (await result.json()).session as {id:string;gpuMode:string;launchImage:string;launchMemoryMb:number;launchOptions:Record<string,unknown>};};
    const directOptions = { diskGb: 32, sdCardMb: 2048, emulatorParams: '-no-boot-anim -timezone Europe/Moscow' };
    const gpu=await start({hostId:'gpu',profileId:'dual',gpuMode:'nvidia',gpuBackend:'gpu',image:'attacker/custom:image',diskGb:32,sdcardGb:2,launchOptions:directOptions});
    assert.deepEqual(gpu.launchOptions,{...directOptions,cpu:2,memoryMb:6144,guestCores:null,guestMemoryMb:null});
    assert.equal(launches[0]?.profile.diskGb,32);assert.equal(launches[0]?.profile.sdCardMb,2048);assert.equal(launches[0]?.profile.emulatorParams,directOptions.emulatorParams);
    assert.equal(gpu.gpuMode,'nvidia');assert.equal(gpu.launchImage,DUAL.image);assert.equal(gpu.launchMemoryMb,6144);
    const cpu=await start({hostId:'cpu',profileId:'dual',gpuMode:'software'});
    assert.equal(cpu.gpuMode,'software');assert.equal(cpu.launchImage,DUAL.image);assert.equal(cpu.launchMemoryMb,6144);
    const dri=await start({hostId:'dri',profileId:'dri',gpuMode:'nvidia'});assert.equal(dri.gpuMode,'nvidia');
    assert.deepEqual(launches.map(item=>item.profile.gpuBackend),['cuda',null,'gpu']);
    assert.ok(launches.every(item => !('gpuSupport' in item.profile)));
    assert.deepEqual(launches.map(item=>[item.profile.image,item.profile.gpuMode]),[[DUAL.image,'nvidia'],[DUAL.image,'software'],[DRI.image,'nvidia']]);
    assert.deepEqual(launches.map(item => item.profile.memoryMb), [6144,6144,4096]);
    // Existing 'none' and mismatched legacy metadata must not disable a node's GPU.
    await start({hostId:'gpu',profileId:'cpu-only',gpuMode:'nvidia'});
    await start({hostId:'dri',profileId:'cpu-only',gpuMode:'nvidia'});
    await start({hostId:'gpu',profileId:'dri',gpuMode:'nvidia'});
    assert.deepEqual(launches.slice(3).map(item => item.profile.gpuBackend), ['cuda', 'gpu', 'cuda']);
    await db.query("INSERT INTO hosts(id,name,slots,status,last_seen_at,slot_cpu,slot_memory_mb,metrics) VALUES('offline','Offline GPU',1,'offline',now(),4,6144,'{\"gpuCapabilities\":[\"cuda\"]}'),('stale','Stale GPU',1,'online',now()-interval '2 minutes',4,6144,'{\"gpuCapabilities\":[\"cuda\"]}')");
    const occupiedBefore = (await db.query('SELECT count(*)::integer AS n FROM host_slots WHERE session_id IS NOT NULL')).rows[0]?.n;
    for(const [body,code,status] of [
      [{hostId:'gpu-small',profileId:'dual',gpuMode:'nvidia'},'profile_too_large',409],
      [{hostId:'cpu',profileId:'dual',gpuMode:'nvidia'},'gpu_unavailable',409],
      [{hostId:'dri',profileId:'dual',gpuMode:'nvidia'},'profile_too_large',409],
      [{hostId:'offline',profileId:'cpu-only',gpuMode:'nvidia'},'agent_offline',503],
      [{hostId:'stale',profileId:'cpu-only',gpuMode:'nvidia'},'agent_offline',503],
      [{hostId:'gpu',profileId:'dual',gpuMode:true},'invalid_gpu_mode',400],
      [{deviceKind:'usb-android',hostId:'gpu',deviceId:'phone',launchOptions:{diskGb:32}},'invalid_launch_options',400],
      [{hostId:'gpu',profileId:'dual',diskGb:24,launchOptions:{diskGb:32}},'invalid_launch_options',400],
      [{hostId:'gpu',profileId:'dual',sdcardGb:3,launchOptions:{sdCardMb:2048}},'invalid_launch_options',400],
      [{hostId:'gpu',profileId:'dual',launchOptions:{diskGb:33}},'storage_out_of_range',409],
      [{deviceKind:'usb-android',hostId:'gpu',deviceId:'phone',sdcardGb:1},'invalid_launch_options',400],
      [{hostId:'gpu',profileId:'dual',launchOptions:{diskGb:0}},'invalid_launch_options',400],
      [{hostId:'gpu',profileId:'dual',launchOptions:{emulatorParams:'-qemu -drive /host'}},'invalid_launch_options',400],
    ] as const) {const result=await request('sessions',body);assert.equal(result.status,status);assert.equal((await result.json()).error.code,code);}
    assert.equal(launches.length,6,'rejected choices never launch');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM host_slots WHERE session_id IS NOT NULL')).rows[0]?.n,occupiedBefore,'rejected choices never reserve');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM sessions')).rows[0]?.n,6);
    await assert.rejects(createSession(context,{id:userId,role:'user'},{hostId:'gpu',profileId:'dual',sessionId:gpu.id,gpuMode:'software'}), (error:unknown)=>error instanceof ApiError&&error.code==='session_conflict');
    const queueOptions = { diskGb: 24, sdCardMb: 0, emulatorParams: '' };
    const queued = await request('queue',{profileId:'dual',gpuMode:'nvidia',launchOptions:queueOptions});assert.equal(queued.status,201,await queued.clone().text());const entry=await queued.json();assert.equal(entry.gpuMode,'nvidia');assert.deepEqual(entry.launchOptions,{...queueOptions,cpu:2,memoryMb:6144,guestCores:null,guestMemoryMb:null});
    const badQueue=await request('queue',{profileId:'dual',hostId:'cpu',gpuMode:'nvidia'});assert.equal(badQueue.status,409);
    const smallQueue=await request('queue',{profileId:'dual',hostId:'gpu-small',gpuMode:'nvidia'});assert.equal(smallQueue.status,409);assert.equal((await smallQueue.json()).error.code,'profile_too_large');
    const invalidQueue=await request('queue',{profileId:'dual',gpuMode:null});assert.equal(invalidQueue.status,400);
    await db.query("UPDATE profiles SET gpu_mode='nvidia',gpu_support='none' WHERE id='dual'");
    await runQueuePass({pool,hub,config,policy:{idleMinutes:0,maxHours:0}});
    const assigned=(await db.query('SELECT gpu_mode,launch_image,launch_memory_mb,host_id FROM sessions WHERE id=$1',[entry.id])).rows[0];
    assert.equal(assigned?.gpu_mode,'nvidia');assert.equal(assigned?.launch_image,DUAL.image);assert.equal(assigned?.host_id,'gpu');assert.equal(assigned?.launch_memory_mb,6144);
    assert.equal(launches.length,7);assert.equal(launches[6]?.profile.sdCardMb,0);assert.equal(launches[6]?.profile.diskGb,24);assert.equal(launches[6]?.profile.emulatorParams,'');assert.equal(launches[6]?.profile.gpuBackend,'cuda');
    await db.query("UPDATE profiles SET memory_mb=3072,disk_gb=8,emulator_params='-verbose' WHERE id='dual'");
    const deviceInfo=await fetch('http://127.0.0.1:'+address.port+'/api/sessions/'+gpu.id+'/device-info');
    assert.equal(deviceInfo.status,200);const snapshot=(await deviceInfo.json()).profile;assert.equal(snapshot.memoryMb,6144);assert.equal(snapshot.diskGb,32);assert.equal(snapshot.sdCardMb,2048);assert.equal(snapshot.emulatorParams,directOptions.emulatorParams);
    assert.equal(launches.length,7);
  } finally {if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await db.close();}
});
