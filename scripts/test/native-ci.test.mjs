import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {orb,bundle,stageAzure,stagePipe} from '../package-native-ci.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url),adapter=require('../../integrations/node/adapter.cjs'),platform=require('../../integrations/platform/entry.cjs');
const {parse}=createRequire(new URL('../../integrations/package.json',import.meta.url))('yaml');
const bash=process.env.RDF_TEST_BASH||(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash');
const shellPath=value=>process.platform==='win32'?value.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,letter)=>'/'+letter.toLowerCase()):value;
const options={url:'https://farm.example.com',profile:'android-30',adbKeyId:'33333333-3333-4333-8333-333333333333',testScript:'test.sh',prepareScript:'prepare.sh',tokenVariable:'TEST_CI_TOKEN',junitReport:'reports/**/*.xml',startTimeoutSeconds:'10'};
function fixture(t,extra={}){
 const directory=mkdtempSync(join(tmpdir(),'rdf-native-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 mkdirSync(join(directory,'bin'));mkdirSync(join(directory,'reports'));
 const put=(file,source)=>writeFileSync(join(directory,file),source,{mode:0o755});
 for(const tool of ['adb','curl'])put('bin/'+tool,'#!/usr/bin/env bash\nFAKE_TOOL='+tool+' exec node "$RDF_SOURCE_ROOT/scripts/test/support/ci-backend.cjs" "$@"\n');
 put('environment.sh','export PATH="$FAKE_BIN:$PATH"\n');
 put('prepare.sh','#!/usr/bin/env bash\nset -eu\n[ -z "${RDF_TOKEN:-}" ] && [ -z "${TEST_CI_TOKEN:-}" ]\nprintf ready > prepared\nexit "${PREPARE_EXIT:-0}"\n');
 put('test.sh','#!/usr/bin/env bash\nset -eu\n[ -z "${RDF_TOKEN:-}" ] && [ -z "${TEST_CI_TOKEN:-}" ]\n[ "$ANDROID_SERIAL" = fixture:15555 ]\nprintf "<testsuite tests=\\"1\\"/>" > reports/result.xml\nexit "${TEST_EXIT:-0}"\n');
 const env={...process.env},previous=Object.entries(env).find(([k])=>k.toLowerCase()==='path')?.[1]||'';
 for(const key of Object.keys(env))if(key.toLowerCase()==='path'||key.startsWith('RDF_')&&!key.startsWith('RDF_TEST_'))delete env[key];
 Object.assign(env,{PATH:[process.env.RDF_TEST_JQ_DIR,process.platform==='win32'?'C:/Program Files/Git/usr/bin':'',previous].filter(Boolean).join(delimiter),
  BASH_ENV:shellPath(join(directory,'environment.sh')),FAKE_BIN:shellPath(join(directory,'bin')),RDF_SOURCE_ROOT:shellPath(root),
  TRACE:shellPath(join(directory,'trace')),STOPPED_FILE:shellPath(join(directory,'stopped')),TEST_CI_TOKEN:'fixture-token',
  RDF_POLL_SECONDS:'1',RDF_RELEASE_TIMEOUT_SECONDS:'2',RDF_HTTP_TIMEOUT_SECONDS:'2',...extra});
 return {directory,env,context:{workspace:directory,env,bash,platform:'linux'},trace:()=>existsSync(join(directory,'trace'))?readFileSync(join(directory,'trace'),'utf8'):''};
}
test('native options reject malformed IDs, insecure URLs and paths before a request',()=>{
 for(const value of [{adbKeyId:'bad'},{url:'https://name:secret@farm.example.com'},{url:'http://farm.example.com'},{testScript:'../test.sh'},{artifactsDirectory:'.'},{tokenVariable:'X;echo'},{startTimeoutSeconds:'0001'}])assert.throws(()=>adapter.configure({...options,...value}));
 assert.equal(adapter.configure(options).tokenVariable,'TEST_CI_TOKEN');
});
test('real common CLI runs through native adapter, removes custom credentials, copies JUnit and releases',async t=>{
 const f=fixture(t),result=await adapter.run(options,f.context);
 assert.equal(result.code,0);
 assert.ok(existsSync(join(f.directory,'prepared')));
 assert.ok(existsSync(join(result.directory,'junit/reports/result.xml')));
 assert.equal(JSON.parse(readFileSync(join(result.directory,'farm-result.json'))).releaseConfirmed,true);
 assert.match(f.trace(),/"method":"DELETE","path":"\/api\/sessions/);
 const metadata=readFileSync(join(result.directory,'ci-run.json'),'utf8');assert.doesNotMatch(metadata,/fixture-token/);
 assert.equal((await adapter.recover(result.directory,f.context)).code,0);
});
test('native adapter preserves test failure and pending release for a later post hook',async t=>{
 const f=fixture(t,{TEST_EXIT:'7',CLEANUP_PENDING:'1'}),result=await adapter.run(options,f.context);
 assert.equal(result.code,7);assert.ok(existsSync(join(result.directory,'session.json')));
 delete f.env.CLEANUP_PENDING;
 assert.equal((await adapter.recover(result.directory,f.context)).code,0);
 assert.ok(!existsSync(join(result.directory,'session.json')));
 assert.equal(JSON.parse(readFileSync(join(result.directory,'ci-run.json'),'utf8')).code,7);
});
test('preparation fails before allocation; state and callbacks still permit a safe post',async t=>{
 const f=fixture(t,{PREPARE_EXIT:'5'});let saved;
 const result=await adapter.run(options,{...f.context,state:value=>saved=value});
 assert.equal(result.code,5);assert.equal(saved,result.directory);assert.equal(f.trace(),'');
 delete f.env.TEST_CI_TOKEN;
 assert.equal((await adapter.recover(result.directory,f.context)).code,0);
});
test('artifact directories and recovery cannot follow links outside the checkout',async t=>{
 const f=fixture(t),outside=mkdtempSync(join(tmpdir(),'rdf-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 symlinkSync(outside,join(f.directory,'rdf-artifacts'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(adapter.run(options,f.context),/leaves/);assert.equal(f.trace(),'');
 await assert.rejects(adapter.recover(outside,f.context),/Invalid/);
});
test('JUnit collector ignores stale XML and symlinked report files',t=>{
 const f=fixture(t);writeFileSync(join(f.directory,'reports/stale.xml'),'<testsuite/>');
 const dir=join(f.directory,'rdf-artifacts/run');mkdirSync(dir,{recursive:true});
 adapter.reports(f.directory,adapter.configure(options),dir,Date.now()+2000);
 assert.equal(existsSync(join(dir,'junit')),false);
});
test('platform metadata and Azure main/post use correct input/state conventions',()=>{
 const action=parse(readFileSync(join(root,'action.yml'),'utf8')),task=JSON.parse(readFileSync(join(root,'integrations/azure-pipelines/task/task.json'))),manifest=JSON.parse(readFileSync(join(root,'integrations/azure-pipelines/vss-extension.json')));
 assert.equal(action.runs.using,'node24');assert.equal(action.runs['post-if'],'always()');
 assert.ok(existsSync(join(root,action.runs.main)));assert.ok(existsSync(join(root,action.runs.post)));
 assert.equal(task.execution.Node24.target,'main.cjs');assert.equal(task.postjobexecution.Node24.target,'post.cjs');
 assert.equal(manifest.contributions[0].properties.name,'task');
 assert.equal(platform.inputs('github',{'INPUT_ADB-KEY-ID':options.adbKeyId}).adbKeyId,options.adbKeyId);
 assert.equal(platform.inputs('azure',{INPUT_ADBKEYID:options.adbKeyId}).adbKeyId,options.adbKeyId);
 assert.equal(platform.key({SYSTEM_TASKINSTANCEID:'abcdef-123'}),'RDF_RUN_ABCDEF_123');
 assert.equal(platform.azureEscape('x];\n'),'x%5D%3B%0A');
});
test('GitHub main saves the directory before runtime; post reads it without reallocating',async t=>{
 const run=adapter.run,recover=adapter.recover,oldExit=process.exitCode;const f=fixture(t);
 const output=join(f.directory,'output'),state=join(f.directory,'state');writeFileSync(output,'');writeFileSync(state,'');
 const env={GITHUB_WORKSPACE:f.directory,GITHUB_OUTPUT:output,GITHUB_STATE:state,'INPUT_URL':options.url,'INPUT_PROFILE':options.profile,'INPUT_ADB-KEY-ID':options.adbKeyId};
 try {
  adapter.run=async(values,context)=>{context.state('/fixture/run');context.output('artifacts-directory','/fixture/run');return {code:0,directory:'/fixture/run'};};
  await platform.main('github',env);
  assert.match(readFileSync(state,'utf8'),/^rdfDirectory=\/fixture\/run\n$/);
  assert.match(readFileSync(output,'utf8'),/^artifacts-directory=\/fixture\/run\n$/);
  adapter.recover=async(directory)=>{assert.equal(directory,'/fixture/run');return {code:0};};
  await platform.post('github',{...env,STATE_rdfDirectory:'/fixture/run'});
 } finally {adapter.run=run;adapter.recover=recover;process.exitCode=oldExit;}
});
test('CircleCI Orb is self-contained and publishes tests/artifacts after errors',()=>{
 const packed=orb();assert.equal(readFileSync(join(root,'integrations/circleci/orb.yml'),'utf8'),packed);
 const value=parse(packed),steps=value.commands['run-tests'].steps;
 assert.equal(steps[1].run.when,'always');assert.ok(steps.some(step=>step.store_test_results));assert.ok(steps.some(step=>step.store_artifacts));
 const payload=/Buffer.from\('([^']+)','base64'\)/.exec(steps[0].run.command)[1];
 assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(payload,'base64'))),bundle());
 assert.ok(Buffer.byteLength(packed)<128*1024);
});
test('Azure and Bitbucket staged packages contain all dependencies and no repository state',()=>{
 const azure=stageAzure(),pipe=stagePipe();
 for(const directory of [join(azure,'task'),pipe]){
  assert.ok(existsSync(join(directory,'common/rdf.sh')));
  assert.ok(existsSync(join(directory,'node/adapter.cjs')));
  assert.ok(!existsSync(join(directory,'.git')));
  assert.ok(!existsSync(join(directory,'.env')));
 }
 assert.match(readFileSync(join(azure,'task/main.cjs'),'utf8'),/require\('\.\/platform\/entry.cjs'\)/);
 const metadata=parse(readFileSync(join(pipe,'pipe.yml'),'utf8'));assert.equal(metadata.name,'Remote Device Farm');
 assert.doesNotMatch(readFileSync(join(pipe,'Dockerfile'),'utf8'),/docker\.sock|privileged/);
});


test('native CLI refuses a second allocation until its pending pointer is recovered',async t=>{
 const f=fixture(t,{CLEANUP_PENDING:'1'}),cli=require('../../integrations/node/cli.cjs');
 Object.assign(f.env,{RDF_URL:options.url,RDF_PROFILE:options.profile,RDF_ADB_KEY_ID:options.adbKeyId,RDF_TEST_SCRIPT:'test.sh',RDF_PREPARE_SCRIPT:'prepare.sh',
 RDF_TOKEN_VARIABLE:'TEST_CI_TOKEN',RDF_JUNIT_REPORT:'reports/**/*.xml',RDF_START_TIMEOUT_SECONDS:'10'});
 const result=await cli.main('run',f.env,f.context);
 assert.notEqual(result.code,0);assert.ok(existsSync(join(f.directory,'rdf-artifacts/ci-state.json')));
 const posts=(f.trace().match(/"method":"POST","path":"\/api\/queue"/g)||[]).length;
 await assert.rejects(cli.main('run',f.env,f.context),/prior CI request/);
 assert.equal((f.trace().match(/"method":"POST","path":"\/api\/queue"/g)||[]).length,posts);
 delete f.env.CLEANUP_PENDING;delete f.env.TEST_CI_TOKEN;
 assert.notEqual((await cli.main('recover',f.env,f.context)).code,0);
 assert.ok(existsSync(join(f.directory,'rdf-artifacts/ci-state.json')));
 f.env.TEST_CI_TOKEN='fixture-token';
 assert.equal((await cli.main('recover',f.env,f.context)).code,0);
 assert.ok(!existsSync(join(f.directory,'rdf-artifacts/ci-state.json')));
});
test('Azure state is isolated per task instance and post recovers the saved instance',async()=>{
 const run=adapter.run,recover=adapter.recover,log=console.log,oldExit=process.exitCode;const lines=[];
 try{
  console.log=line=>lines.push(line);
  adapter.run=async(values,context)=>{context.state('/fixture/run-one');return {code:0};};
  const env={SYSTEM_TASKINSTANCEID:'task-one',INPUT_URL:options.url,INPUT_PROFILE:options.profile,INPUT_ADBKEYID:options.adbKeyId};
  await platform.main('azure',env);
  assert.match(lines[0],/variable=RDF_RUN_TASK_ONE/);
  assert.notEqual(platform.key(env),platform.key({...env,SYSTEM_TASKINSTANCEID:'task-two'}));
  adapter.recover=async directory=>{assert.equal(directory,'/fixture/run-one');return {code:0};};
  await platform.post('azure',{...env,RDF_RUN_TASK_ONE:'/fixture/run-one'});
 }finally{adapter.run=run;adapter.recover=recover;console.log=log;process.exitCode=oldExit;}
});
test('packagers reject unlisted private files instead of including them',()=>{
 const directory=stageAzure(),file=join(directory,'task/unlisted.json');writeFileSync(file,'{"fixture":true}');
 try{assert.throws(()=>stageAzure(),/Unexpected staged/);}finally{rmSync(file);}
});
test('native guides and repository workflow contain parseable YAML examples',()=>{
 for(const name of ['github-actions','azure-pipelines','bitbucket-pipelines']){
  const text=readFileSync(join(root,'docs/ci/'+name+'.md'),'utf8');
  for(const match of text.matchAll(/^```yaml\r?\n([\s\S]*?)^```/gm))assert.doesNotThrow(()=>parse(match[1]),name);
 }
 assert.doesNotThrow(()=>parse(readFileSync(join(root,'.github/workflows/ci.yml'),'utf8')));
});
