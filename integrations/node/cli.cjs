'use strict';
const fs=require('node:fs'),path=require('node:path');
const adapter=require('./adapter.cjs');
const variables={url:'RDF_URL',profile:'RDF_PROFILE',adbKeyId:'RDF_ADB_KEY_ID',testScript:'RDF_TEST_SCRIPT',prepareScript:'RDF_PREPARE_SCRIPT',
 environmentScript:'RDF_ENV_SCRIPT',artifactsDirectory:'RDF_ARTIFACTS_DIRECTORY',tokenVariable:'RDF_TOKEN_VARIABLE',adbKeyFile:'RDF_ADB_KEY_FILE',
 caFile:'RDF_CA_FILE',startTimeoutSeconds:'RDF_START_TIMEOUT_SECONDS',testTimeoutSeconds:'RDF_TEST_TIMEOUT_SECONDS',junitReport:'RDF_JUNIT_REPORT',label:'RDF_LABEL'};
function inputs(env){return Object.fromEntries(Object.entries(variables).filter(([,name])=>env[name]).map(([name,variable])=>[name,env[variable]]));}
function pointer(workspace,env){
 const name=env.RDF_ARTIFACTS_DIRECTORY || 'rdf-artifacts';
 if(!/^[A-Za-z0-9_./-]+$/.test(name)||name.split('/').includes('..')||path.isAbsolute(name)||name==='.')throw new Error('Invalid artifacts path');
 const parent=path.resolve(workspace,name);adapter.directoryInside(workspace,parent);
 if(!adapter.inside(workspace,fs.realpathSync(parent)))throw new Error('State path leaves checkout');
 return path.join(parent,'ci-state.json');
}
async function main(mode,env=process.env,context={}){
 const workspace=fs.realpathSync(context.workspace||env.BITBUCKET_CLONE_DIR||process.cwd()),state=pointer(workspace,env);
 const options={...context,workspace,env,credentialFiles:{adbKeyFile:env.RDF_ADB_KEY_FILE,caFile:env.RDF_CA_FILE},tools:context.tools||env.RDF_TOOL_DIRECTORY};
 if(mode==='recover'){
  if(!fs.existsSync(state))return {code:0};
  if(fs.lstatSync(state).isSymbolicLink())throw new Error('Recovery pointer must be a regular file');
  const saved=JSON.parse(fs.readFileSync(state,'utf8'));
  if(typeof saved.directory!=='string'||!saved.directory)throw new Error('Recovery pointer is invalid');
  const result=await adapter.recover(saved.directory,options);
  if(result.code===0)fs.unlinkSync(state);
  return result;
 }
 if(mode!=='run')throw new Error('Use run or recover');
 if(fs.existsSync(state))throw new Error('A prior CI request needs recovery');
 const result=await adapter.run(inputs(env),{...options,state:directory=>fs.writeFileSync(state,JSON.stringify({directory}),{mode:0o600,flag:'wx'})});
 const finalization=await main('recover',env,context);
 return {...result,code:result.code||finalization.code};
}
if(require.main===module)main(process.argv[2]||'run').then(result=>{process.exitCode=result.code;}).catch(()=>{console.error('CI operation failed; check configuration and retain pending recovery state');process.exitCode=1;});
module.exports={main,inputs,pointer};
