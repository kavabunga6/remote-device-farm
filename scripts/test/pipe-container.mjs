#!/usr/bin/env node
// Exercises the actual Pipe entry point in a bounded container against modeled API/ADB.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const image=process.env.RDF_TEST_PIPE_IMAGE;
if(!image)throw new Error('Set RDF_TEST_PIPE_IMAGE to a locally built Pipe image');
if(!/^[A-Za-z0-9_./:@-]+$/.test(image))throw new Error('Invalid test image');
const directory=mkdtempSync(join(tmpdir(),'rdf-pipe-container-'));
try{
 mkdirSync(join(directory,'bin'));mkdirSync(join(directory,'reports'));
 const put=(file,body)=>writeFileSync(join(directory,file),body,{mode:0o755});
 put('bin/curl','#!/usr/bin/env bash\nFAKE_TOOL=curl exec node "$RDF_SOURCE_ROOT/scripts/test/support/ci-backend.cjs" "$@"\n');
 put('bin/adb','#!/usr/bin/env bash\nexec node "$RDF_SOURCE_ROOT/scripts/test/support/adb-runtime-backend.cjs" "$@"\n');
 put('environment.sh','export PATH=/workspace/bin:$PATH\n');
 put('test.sh','#!/usr/bin/env bash\nset -eu\n[ -z "${RDF_TOKEN:-}" ]\n[ -z "${RDF_ADB_KEY_BASE64:-}" ]\n[ "$ANDROID_SERIAL" = fixture:15555 ]\nprintf "<testsuite tests=\\"1\\"/>" > reports/result.xml\nexit "${TEST_EXIT:-0}"\n');
 const env={
 BITBUCKET_CLONE_DIR:'/workspace',BASH_ENV:'/workspace/environment.sh',RDF_SOURCE_ROOT:'/support',TRACE:'/workspace/trace',STOPPED_FILE:'/workspace/stopped',
 RDF_URL:'https://farm.example.com',RDF_PROFILE:'android-30',RDF_ADB_KEY_ID:'33333333-3333-4333-8333-333333333333',RDF_TOKEN:'fixture-token',
 RDF_ADB_KEY_BASE64:Buffer.from('fixture-private-key').toString('base64'),RDF_JUNIT_REPORT:'reports/**/*.xml',RDF_TEST_SCRIPT:'test.sh',
 RDF_POLL_SECONDS:'1',RDF_HTTP_TIMEOUT_SECONDS:'2',RDF_RELEASE_TIMEOUT_SECONDS:'2',RDF_START_TIMEOUT_SECONDS:'10'
 };
 const args=['run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1',
  '--user',String(process.getuid())+':'+String(process.getgid()),'-v',directory+':/workspace',
  '-v',join(root,'scripts/test/support')+':/support/scripts/test/support:ro'];
 function run(extra={}) {
  const result=spawnSync('docker',[...args,...Object.entries({...env,...extra}).flatMap(([key,value])=>['-e',key+'='+value]),image],
   {encoding:'utf8',timeout:60000});
  if(result.error)throw result.error;return result;
 }
 let result=run();assert.equal(result.status,0,result.stdout+result.stderr);
 const parent=join(directory,'rdf-artifacts'),first=readdirSync(parent).find(name=>name!=='ci-state.json'),runDirectory=join(parent,first);
 assert.equal(JSON.parse(readFileSync(join(runDirectory,'farm-result.json'),'utf8')).releaseConfirmed,true);
 assert.equal(JSON.parse(readFileSync(join(runDirectory,'adb-runtime.json'),'utf8')).privateKeyRemoved,true);
 assert.ok(existsSync(join(runDirectory,'junit/reports/result.xml')));
 assert.doesNotMatch(result.stdout+result.stderr,/fixture-token|fixture-private-key/);
 // A second container must recover the original pending request with fresh secret paths.
 rmSync(join(directory,'stopped'));
 result=run({CLEANUP_PENDING:'1',TEST_EXIT:'7'});assert.equal(result.status,7,result.stdout+result.stderr);
 assert.ok(existsSync(join(parent,'ci-state.json')));
 result=run({RDF_OPERATION:'recover'});assert.equal(result.status,0,result.stdout+result.stderr);
 assert.ok(!existsSync(join(parent,'ci-state.json')));
 console.log('Pipe entry, private key cleanup, failed tests and cross-container recovery passed');
}finally{
 // This directory was created by this process in the system temp directory.
 if(dirname(directory)!==resolve(tmpdir())||!directory.startsWith(join(resolve(tmpdir()),'rdf-pipe-container-')))throw new Error('Unexpected fixture path');
 rmSync(directory,{recursive:true,force:true});
}
