'use strict';
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../node/adapter.cjs');
const fieldNames = {url:'url',profile:'profile',adbKeyId:'adb-key-id',testScript:'test-script',prepareScript:'prepare-script',environmentScript:'environment-script',
  artifactsDirectory:'artifacts-directory',tokenVariable:'token-variable',adbKeyFile:'adb-key-file',caFile:'ca-file',startTimeoutSeconds:'start-timeout-seconds',
  testTimeoutSeconds:'test-timeout-seconds',junitReport:'junit-report',label:'label'};
function inputName(name, platform) {
  return platform === 'azure' ? name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()).toUpperCase() : name.toUpperCase().replaceAll(' ','_');
}
function inputs(platform, env = process.env) {
  const values = {};
  for (const [name, field] of Object.entries(fieldNames)) {
    const value = env['INPUT_' + inputName(field, platform)];
    if (value !== undefined && value !== '') values[name]=value;
  }
  return values;
}
function githubEscape(text) { return String(text).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'); }
function azureEscape(text) { return String(text).replaceAll('%','%AZP25').replaceAll('\r','%0D').replaceAll('\n','%0A').replaceAll(']','%5D').replaceAll(';','%3B'); }
function key(env) {
  const value = env.SYSTEM_TASKINSTANCEID || env.TASK_INSTANCEID || env.TASK_INSTANCE_ID;
  if (!value || !/^[A-Za-z0-9-]+$/.test(value)) throw new Error('Azure task instance ID is missing');
  return 'RDF_RUN_' + value.replaceAll('-','_').toUpperCase();
}
function append(file, name, value) {
  if (!file || /[\r\n]/.test(value)) throw new Error('CI state file is unavailable');
  fs.appendFileSync(file, name+'='+value+'\n');
}
async function main(platform, env = process.env, context = {}) {
  const values = inputs(platform,env);
  const variable=values.tokenVariable || 'RDF_TOKEN';
  if (env[variable]) {
    const secret = platform === 'github' ? '::add-mask::'+githubEscape(env[variable]) : '##vso[task.setsecret]'+azureEscape(env[variable]);
    console.log(secret);
  }
  const workspace = context.workspace || (platform === 'github' ? env.GITHUB_WORKSPACE : env.BUILD_SOURCESDIRECTORY) || process.cwd();
  const result=await adapter.run(values,{...context,env,workspace,
    state: directory => {
      if (platform === 'github') append(env.GITHUB_STATE,'rdfDirectory',directory);
      else console.log('##vso[task.setvariable variable='+key(env)+';]'+azureEscape(directory));
    },
    output: (name,directory) => {
      if (platform === 'github') append(env.GITHUB_OUTPUT,name,directory);
      else console.log('##vso[task.setvariable variable=artifactsDirectory;isOutput=true;]'+azureEscape(directory));
    }});
  if (result.code !== 0) {
    console.log(platform === 'github' ? '::error::Android test or device cleanup failed' : '##vso[task.complete result=Failed;]Android test or device cleanup failed');
    process.exitCode=result.code;
  }
  return result;
}
async function post(platform, env = process.env, context = {}) {
  const workspace = context.workspace || (platform === 'github' ? env.GITHUB_WORKSPACE : env.BUILD_SOURCESDIRECTORY) || process.cwd();
  const directory = platform === 'github' ? env.STATE_rdfDirectory : env[key(env)];
  const result=await adapter.recover(directory,{...context,env,workspace});
  if (result.code!==0) { console.log(platform === 'github' ? '::error::Device recovery remains pending' : '##vso[task.complete result=Failed;]Device recovery remains pending');process.exitCode=result.code; }
  return result;
}
module.exports={main,post,inputs,githubEscape,azureEscape,key};
