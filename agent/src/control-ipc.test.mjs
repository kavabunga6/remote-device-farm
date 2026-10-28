import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ControlClient, createControlServer, validateControlRequest } from './control-ipc.mjs';

const SESSION = 'session-1234';
const PROFILE = { image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2', cpu: 2, memoryMb: 4096, diskGb: 8, emulatorParams: '' };
const KEY = 'QUJDRA== rdf@farm\n';

test('control IPC accepts only typed operations and rejects Docker API fields', async () => {
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\rdf-control-' + randomUUID()
    : path.join(os.tmpdir(), 'rdf-control-' + randomUUID() + '.sock');
  const calls = [];
  const server = await createControlServer({ handle: async (request) => {
    calls.push(request);
    return request.op === 'hostInfo' ? { cpuThreads: 4 } : { stopped: true };
  } }, socketPath);
  try {
    const client = new ControlClient(socketPath);
    assert.deepEqual(await client.hostInfo(), { cpuThreads: 4 });
    assert.deepEqual(await client.stop(SESSION), { stopped: true });
    await assert.rejects(client.request('docker', { method: 'POST', path: '/containers/create' }), /Invalid control operation/);
    await assert.rejects(client.request('stop', { sessionId: '../docker' }), /Invalid session ID/);
    await assert.rejects(client.request('hostInfo', { path: '/containers/json' }), /Unexpected control request field/);
    await assert.rejects(client.request('start', {
      sessionId: SESSION, profile: { ...PROFILE, HostConfig: { Privileged: true } }, adbPublicKey: KEY,
    }), /Unexpected emulator profile field/);
    await assert.rejects(client.request('start', {
      sessionId: SESSION, profile: PROFILE, adbPublicKey: 'bad\nDOCKER_HOST=unix:///var/run/docker.sock',
    }), /Invalid ADB public key/);
    assert.deepEqual(calls.map((item) => item.op), ['hostInfo', 'stop']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('control request shape rejects extra paths and invalid session IDs before dispatch', () => {
  assert.throws(() => validateControlRequest({ op: 'setEgress', sessionId: SESSION,
    enabled: false, containerId: '/var/run/docker.sock' }), /Unexpected control request field/);
  assert.throws(() => validateControlRequest({ op: 'stop', sessionId: 'x' }), /Invalid session ID/);
  assert.deepEqual(validateControlRequest({ op: 'setEgress', sessionId: SESSION, enabled: false }),
    { op: 'setEgress', sessionId: SESSION, enabled: false });
});

test('runtime policy IPC rejects raw Docker fields and invalid slot limits', () => {
  const policy = { revision: 1, slots: 3, slotCpu: 4, slotMemoryMb: 8192 };
  assert.deepEqual(validateControlRequest({ op: 'setPolicy', policy }), { op: 'setPolicy', policy });
  assert.throws(() => validateControlRequest({ op: 'setPolicy', policy: { ...policy, Binds: ['/'] } }), /Invalid node policy/);
  assert.throws(() => validateControlRequest({ op: 'setPolicy', policy: { ...policy, slots: 33 } }), /Invalid node policy/);
  assert.throws(() => validateControlRequest({ op: 'setPolicy', policy, containerId: 'host' }), /Unexpected control request field/);
});


test('launch storage is forwarded as typed profile data without raw Docker options', () => {
  const profile = { ...PROFILE, sdCardMb: 1024, gpuMode: 'nvidia', gpuBackend: 'cuda' };
  assert.equal(validateControlRequest({ op: 'start', sessionId: SESSION, profile, adbPublicKey: KEY }).profile.sdCardMb, 1024);
  for (const field of ['Cmd', 'Entrypoint', 'Env', 'Mounts', 'Privileged', 'dockerArgs', 'gpuSupport']) {
    assert.throws(() => validateControlRequest({ op: 'start', sessionId: SESSION,
      profile: { ...profile, [field]: 'bad' }, adbPublicKey: KEY }), /Unexpected emulator profile field/);
  }
});


test('console IPC leaves room for its 20-second execution deadline', async () => {
  const client = new ControlClient();
  const calls = [];
  client.request = async (...args) => { calls.push(args); return { stdout: 'OK\n', exitCode: 0 }; };
  await client.emuConsole(SESSION, ['network', 'status']);
  assert.deepEqual(calls, [['emuConsole', { sessionId: SESSION, args: ['network', 'status'] }, 30_000]]);
});


test('build cancellation travels through typed IPC without Docker or container selectors', async () => {
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\rdf-cancel-' + randomUUID()
    : path.join(os.tmpdir(), 'rdf-cancel-' + randomUUID() + '.sock');
  const calls = [];
  const server = await createControlServer({ handle: async request => { calls.push(request); return { jobs: [{ id: request.jobId, state: 'cancelling' }] }; } }, socketPath);
  try {
    const client = new ControlClient(socketPath);
    assert.equal((await client.emulatorCancel('job-1234')).jobs[0].state, 'cancelling');
    assert.deepEqual(calls, [{ op: 'emulatorCancel', jobId: 'job-1234' }]);
    for (const jobId of ['', '../docker', 'x'.repeat(65), null]) {
      await assert.rejects(client.emulatorCancel(jobId), /Invalid emulator build job ID/);
    }
    await assert.rejects(client.request('emulatorCancel', { jobId: 'job-1234', containerId: 'unrelated' }), /Unexpected/);
    assert.equal(calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('large diagnostic output respects socket backpressure and preserves the complete tail before the result', async () => {
  const socketPath=process.platform==='win32' ? '\\\\.\\pipe\\rdf-diagnostics-'+randomUUID() : path.join(os.tmpdir(),'rdf-diagnostics-'+randomUUID()+'.sock');
  const count=1200, received=[];
  const server=await createControlServer({handle:async (_request,{onLog})=>{
    for(let i=0;i<count;i++)await onLog({code:'container.stdout',message:i+':'+ 'x'.repeat(1000),severity:'info',service:'emulator'});
    return {stopped:true};
  }},socketPath);
  try {
    const result=await new ControlClient(socketPath).stop(SESSION,{onLog:event=>received.push(event)});
    assert.equal(result.stopped,true);assert.equal(received.length,count);
    assert.match(received.at(-1).message,/^1199:/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('cache IPC supports bounded protected references and larger inventories without widening other operations',async()=>{
  const socketPath=process.platform==='win32' ? '\\\\.\\pipe\\rdf-cache-'+randomUUID() : path.join(os.tmpdir(),'rdf-cache-'+randomUUID()+'.sock');
 const server=await createControlServer({handle:async request=>({items:[{references:request.protectedRefs,padding:'x'.repeat(300000)}]})},socketPath);
 try{
  const client=new ControlClient(socketPath),refs=Array.from({length:300},(_,i)=>'registry/rdf-emulator:tag-'+i+'@sha256:'+'a'.repeat(64));
  assert.ok(Buffer.byteLength(JSON.stringify(refs))>16*1024);
  const response=await client.imageCache(refs);assert.equal(response.items[0].references.length,300);assert.equal(response.items[0].padding.length,300000);
  await assert.rejects(client.imageCache(Array.from({length:1001},()=>refs[0])),/Invalid protected images/);
  await assert.rejects(client.request('hostInfo',{extra:'x'.repeat(20000)}),/Control request exceeds limit/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});


test('catalogue status uses an independent typed IPC request while preparation is pending', async () => {
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\rdf-catalog-' + randomUUID()
    : path.join(os.tmpdir(), 'rdf-catalog-' + randomUUID() + '.sock');
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const status = { phase: 'preparing_tools', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { step: 2, steps: 4, percent: null } };
  const server = await createControlServer({ handle: async request => {
    if (request.op === 'emulatorCatalog') { started(); await pending; return { images: [] }; }
    return status;
  } }, socketPath);
  let catalog;
  try {
    const client = new ControlClient(socketPath);
    catalog = client.emulatorCatalog(); await ready;
    assert.deepEqual(await client.emulatorCatalogStatus(), status);
    await assert.rejects(client.request('emulatorCatalogStatus', { containerId: 'other' }), /Unexpected/);
    finish(); assert.deepEqual(await catalog, { images: [] });
  } finally { finish(); await catalog; await new Promise(resolve => server.close(resolve)); }
});
