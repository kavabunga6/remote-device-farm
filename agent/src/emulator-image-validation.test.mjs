import test from 'node:test';
import assert from 'node:assert/strict';
import {EmulatorImageValidator,imageCheckResult} from './emulator-image-validation.mjs';
import {AgentControl} from './agent-control.mjs';

const evidence={version:1,...Object.fromEntries(['bootCompleted','adbSecure','unauthorizedAdb','rendererVerified','deviceVerified','resourcesVerified'].map(k=>[k,true]))};
const entry={package:'system-images;android-34;google_apis;x86_64',device:'phone'};
function fakeDocker({output='RDF_VALIDATION '+JSON.stringify(evidence),exitCode=0,cleanupFails=false}={}) {
  let body,network,exists=false,networkExists=false;const calls=[];
  return {calls,get body(){return body;},get network(){return network;},
    async inspect(id) {if(!exists)throw new Error('No such container');return {Id:'checker-id',Config:{Labels:body.Labels}};},
    async listManaged(){return [];},
    async request(method,path,value,options={}) {
      calls.push({method,path,body:value,options});
      if(path.startsWith('/images/'))return {Id:'sha256:immutable',Config:{Labels:{'remote-device-farm.contract':'emulator-v1','remote-device-farm.system-image':entry.package}}};
      if(path==='/networks/create'){network=value;networkExists=true;return {Id:'network-id'};}
      if(path.startsWith('/networks?'))return [];
      if(path==='/networks/network-id'&&method==='GET'){if(!networkExists)throw new Error('404');return {Id:'network-id',Labels:network.Labels,Containers:{}};}
      if(path.startsWith('/containers/create')){body=value;exists=true;return {Id:'checker-id'};}
      if(path.endsWith('/wait'))return {StatusCode:exitCode};
      if(path.includes('/logs'))return Buffer.from(output);
      if(method==='DELETE'&&path.startsWith('/containers/')){if(cleanupFails)throw new Error('Docker cleanup failed');exists=false;}
      if(method==='DELETE'&&path.startsWith('/networks/'))networkExists=false;
      return {};
    }};
}

test('missing, partial and non-current runtime results fail closed with concrete diagnostics',()=>{
  for(const text of ['','RDF_VALIDATION {}','RDF_VALIDATION {bad','RDF_VALIDATION '+JSON.stringify({...evidence,unauthorizedAdb:false})])assert.throws(()=>imageCheckResult(text),error=>error.code==='image_invalid');
  assert.throws(()=>imageCheckResult('ERROR | image.validation: untrusted ADB key received device access'),/untrusted ADB/);
});

test('checker uses immutable image and isolated bounded resources, and removes only its own artifacts',async()=>{
  const docker=fakeDocker();const checker=new EmulatorImageValidator({docker,agentId:'builder'});
  const result=await checker.run('registry/image:34',{entry});
  assert.equal(result.adbSecure,true);assert.equal(result.imageId,'sha256:immutable');
  assert.equal(docker.body.Image,'sha256:immutable');
  assert(docker.body.Env.includes('RDF_EXTRA_ARGS=-adb-path /bin/false'), 'Validation must use the same ADB policy as real sessions');
  assert(docker.body.Cmd[1].includes('USB debugging confirmation is visible at startup'));
  assert(docker.body.Cmd[1].indexOf('USB debugging confirmation is visible at startup')<docker.body.Cmd[1].indexOf('adb_call stranger connect'));assert.equal(docker.network.Internal,true);
  assert.equal(docker.body.HostConfig.Memory,6144*1048576);
  assert.equal(docker.body.HostConfig.NanoCpus,4e9);
  assert.ok(!docker.body.HostConfig.PortBindings);
  assert.equal(docker.body.Labels['remote-device-farm.session'],undefined);
  assert.deepEqual(docker.calls.filter(c=>c.method==='DELETE').map(c=>c.path),['/containers/checker-id?force=1&v=1','/networks/network-id']);
});

test('bad image, nonzero checker exit, and cleanup failure cannot become successful validation',async()=>{
  for(const options of [{output:'ERROR | image.validation: boot failed',exitCode:64},{exitCode:64},{cleanupFails:true}]) {
    const docker=fakeDocker(options);const checker=new EmulatorImageValidator({docker,agentId:'builder'});
    await assert.rejects(checker.run('registry/image:34',{entry}));
    assert.ok(docker.calls.some(c=>c.method==='DELETE'&&c.path.includes('checker-id')));
  }
});

test('cleanup refuses containers and networks without matching ownership',async()=>{
  const docker=fakeDocker();const checker=new EmulatorImageValidator({docker,agentId:'builder'});
  docker.inspect=async()=>({Id:'unrelated',Config:{Labels:{}}});
  await assert.rejects(checker.cleanup('unrelated','our-check'),/unrelated/);
  docker.request=async(method,path)=>{assert.equal(method,'GET');return {Id:'unrelated',Labels:{}};};
  await assert.rejects(checker.cleanupNetwork('unrelated','our-check'),/unrelated/);
});

test('cleanup failures propagate even when validation was preempted by a user start',async()=>{
  const control=Object.create(AgentControl.prototype);
  Object.assign(control,{config:{agentId:'builder'},preparing:new Map(),startQueue:Promise.resolve(),imageCheckFlight:null,imageCheckController:null,
    hostInfo:async()=>({kvm:true}),capacity:async()=>({occupied:[],host:{memoryAvailableMb:16000}}),
    imageValidator:{run:async()=>{control.imageCheckController.abort(new Error('preempted'));const error=new Error('cleanup failed');error.code='image_check_cleanup';throw error;}}});
  await assert.rejects(control.verifyArtifact('image',{entry,signal:new AbortController().signal,onLine:()=>{}}),error=>error.code==='image_check_cleanup');
});

test('one shared checker covers all generated device variants and available hardware modes',async()=>{
  const control=Object.create(AgentControl.prototype),calls=[];
  Object.assign(control,{config:{agentId:'builder'},preparing:new Map(),startQueue:Promise.resolve(),
    hostInfo:async()=>({kvm:true,nvidiaRuntime:true,driGpu:true}),capacity:async()=>({occupied:[],host:{memoryAvailableMb:16000}}),
    imageValidator:{run:async(image,options)=>{calls.push({image,...options});return {...evidence,imageId:'sha256:immutable'};}}});
  const profiles=[{id:'phone',resources:{memoryMb:6144}},{id:'tablet',resources:{memoryMb:6144}}];
  const result=await control.verifyArtifact('registry/image:34',{entry,profiles,signal:new AbortController().signal,onLine:()=>{}});
  assert.deepEqual(calls.map(c=>c.mode??'off'),['off','off','nvidia','dri']);
  assert.deepEqual(calls.slice(0,2).map(c=>c.profile.id),['phone','tablet']);
  assert.ok(calls.slice(1).every(c=>c.image==='sha256:immutable'));
  assert.equal(result.profiles.length,2);assert.equal(result.checks.nvidia.adbSecure,true);
});

test('validation waits on an occupied builder and can be cancelled without creating anything',async()=>{
  const control=Object.create(AgentControl.prototype),abort=new AbortController();let waited=false;
  Object.assign(control,{preparing:new Map(),hostInfo:async()=>({kvm:true}),capacity:async()=>({occupied:[{}],host:{memoryAvailableMb:16000}}),imageValidator:{run:async()=>{throw new Error('must not run');}}});
  const pending=control.verifyArtifact('image',{entry,signal:abort.signal,onLine:()=>{waited=true;queueMicrotask(()=>abort.abort(new Error('test cancelled')));}});
  await assert.rejects(pending,/test cancelled|aborted/);assert.equal(waited,true);
});
