import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerClient } from './docker.mjs';
import { diagnosticSecrets, diagnosticSeverity, dockerLogLines, redactDiagnostic } from './session-diagnostics.mjs';
const frame = (kind, text) => { const data=Buffer.from(text), header=Buffer.alloc(8);header[0]=kind;header.writeUInt32BE(data.length,4);return Buffer.concat([header,data]); };
test('container diagnostics preserve fragmented UTF-8, exit status and stdout/stderr before removal and hide environment secrets', async () => {
  const docker = new DockerClient('/unused'), events=[], order=[];
  const bytes=Buffer.from('2026-10-07T10:00:00Z Ошибка GPU\n');
  const raw=Buffer.concat([frame(2,bytes.subarray(0,24)),frame(1,'password=hidden OPAQUE-SECRET\n'),frame(2,bytes.subarray(24))]);
  docker.inspect = async () => ({Id:'owned', Config:{Labels:{'remote-device-farm.session':'session-1','remote-device-farm.agent':'agent-1'}, Env:['CUSTOM=OPAQUE-SECRET']}, State:{Status:'exited',Running:false,ExitCode:139,OOMKilled:true}});
  docker.requestRaw=async (_method,path) => { order.push(path);return raw; };
  await docker.captureDiagnostics('owned','session-1','agent-1',event=>events.push(event));
  assert.equal(events.find(e=>e.code==='container.state').severity,'error');
  assert.match(events.find(e=>e.code==='container.state').message,/"exitCode":139/);
  assert.match(events.find(e=>e.code==='container.stderr').message,/Ошибка GPU/);
  assert.ok(!JSON.stringify(events).includes('OPAQUE-SECRET'));
  assert.ok(!JSON.stringify(events).includes('hidden'));
  assert.match(order[0],/tail=2000/);
  docker.inspect=async()=>({Config:{Labels:{'remote-device-farm.session':'different','remote-device-farm.agent':'agent-1'}}});
  await docker.captureDiagnostics('unrelated','session-1','agent-1',event=>events.push(event));
  assert.equal(order.length,1,'unrelated container output is never read');
  assert.equal(events.at(-1).code,'container.diagnostics_failed');
});
test('malformed Docker streams and credential-bearing lines cannot leak into diagnostics', () => {
  assert.throws(()=>dockerLogLines(Buffer.from('bad stream')));
  const cleaned=redactDiagnostic('https://user:pw@example.test password=secret ADBKEY_PUB=base64key Bearer authvalue',[]);
  for(const secret of ['user:pw','secret','base64key','authvalue'])assert.ok(!cleaned.includes(secret));
  assert.equal(redactDiagnostic('x'.repeat(10000)).length,4096);
});


test('runtime paths and display settings remain readable while arbitrary environment values stay private', async () => {
  assert.deepEqual(diagnosticSecrets(null), []);
  const env=['HOME=/android-home','PATH=/opt/android/emulator:/usr/bin','ANDROID_AVD_HOME=/android-home/avd',
    'RDF_SCREEN=1080x2400','RDF_RAM_MB=4096','CUSTOM=OPAQUE-SECRET','API_TOKEN=shared-token',
    'ADBKEY_PUB=long-base64-public-key rdf-agent'];
  const text='Setting display: [1080x2400], memory 4096; /android-home/.android/emu-update-last-check.ini; OPAQUE-SECRET shared-token long-base64-public-key';
  const result=redactDiagnostic(text,diagnosticSecrets(env));
  for(const readable of ['1080x2400','4096','/android-home/.android/emu-update-last-check.ini'])assert.ok(result.includes(readable));
  for(const secret of ['OPAQUE-SECRET','shared-token','long-base64-public-key'])assert.ok(!result.includes(secret));
  const docker=new DockerClient('/unused'),events=[];
  docker.inspect=async()=>({Id:'owned',Config:{Labels:{'remote-device-farm.session':'s','remote-device-farm.agent':'a'},Env:env},State:{Running:true,ExitCode:0}});
  docker.requestRaw=async()=>frame(1,'2026-10-07T16:36:29.762899794Z INFO | '+text+'\n2026-10-07T16:36:29.780366463Z WARNING | Failed to process .ini file /android-home/.android/emu-update-last-check.ini\n');
  await docker.captureDiagnostics('owned','s','a',event=>events.push(event));
  const output=events.filter(e=>e.code==='container.stdout');
  assert.match(output[0].message,/1080x2400/);assert.ok(!output[0].message.includes('OPAQUE-SECRET'));
  assert.equal(output[0].severity,'info');assert.equal(output[1].severity,'warning');
});

test('explicit container log levels survive the stdout transport without turning incidental words into errors', () => {
  for(const level of ['WARNING','WARN','USER_WARNING'])assert.equal(diagnosticSeverity('2026-10-07T16:36:29Z '+level+'   | message'),'warning');
  for(const level of ['ERROR','FATAL','PANIC'])assert.equal(diagnosticSeverity(level+' | message'),'error');
  assert.equal(diagnosticSeverity('INFO | error counter: 0','stderr'),'info');
  assert.equal(diagnosticSeverity('[WARNING] optional audio backend'),'warning');
  assert.equal(diagnosticSeverity('pulseaudio: Failed to initialize PA context'),'warning');
  assert.equal(diagnosticSeverity('An example mentioning FATAL in ordinary output'),'info');
  assert.equal(diagnosticSeverity('plain output','stderr'),'warning');
});
