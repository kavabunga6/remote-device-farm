#!/usr/bin/env node
// Native packages contain an explicit source allowlist and no workstation state.
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sources={
 'common/rdf.sh':'scripts/rdf.sh',
 'common/run-tests.sh':'integrations/common/run-tests.sh',
 'common/managed-runtime.sh':'integrations/common/managed-runtime.sh',
 'common/managed-cleanup.sh':'integrations/common/managed-cleanup.sh',
 'common/native-entry.sh':'integrations/common/native-entry.sh',
 'node/adapter.cjs':'integrations/node/adapter.cjs',
 'node/cli.cjs':'integrations/node/cli.cjs',
 'NOTICE':'NOTICE',
 'THIRD_PARTY.md':'THIRD_PARTY.md',
 'LICENSE':'LICENSE'
};
function verifyPayload(directory,allowed){
 for(let current=directory;current!==root;current=dirname(current)){
  if(current===dirname(current))throw new Error('Invalid staging root');
  if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('Staging path contains a symbolic link');
 }
 if(!existsSync(directory))return;
 function visit(folder){
  for(const entry of readdirSync(folder,{withFileTypes:true})){
   const file=join(folder,entry.name);if(entry.isSymbolicLink())throw new Error('Staged package contains a symbolic link');
   if(entry.isDirectory())visit(file);else if(!allowed.has(relative(directory,file).split(sep).join('/')))throw new Error('Unexpected staged package content');
  }
 }
 visit(directory);
}
export function bundle(){return Object.fromEntries(Object.entries(sources).map(([target,source])=>[target,readFileSync(join(root,source),'utf8').replaceAll('\r\n','\n')]));}
function populate(directory){for(const [name,source] of Object.entries(bundle())){const target=join(directory,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source);}}
export function orb(){
 const source=readFileSync(join(root,'integrations/circleci/orb.template.yml'),'utf8').replaceAll('\r\n','\n');
 return source.replace('__RDF_BUNDLE__',Buffer.from(JSON.stringify(bundle())).toString('base64'));
}
export function stageAzure(){
 const directory=join(root,'integrations/azure-pipelines/build/package');
 const allowed=new Set(['vss-extension.json',...Object.keys(sources).map(name=>'task/'+name),'task/task.json','task/platform/entry.cjs','task/main.cjs','task/post.cjs']);
 verifyPayload(directory,allowed);
 mkdirSync(directory,{recursive:true});
 const manifest=JSON.parse(readFileSync(join(root,'integrations/azure-pipelines/vss-extension.json'),'utf8'));
 if(process.env.RDF_AZURE_PUBLISHER){if(!/^[a-zA-Z0-9-]+$/.test(process.env.RDF_AZURE_PUBLISHER))throw new Error('Invalid publisher');manifest.publisher=process.env.RDF_AZURE_PUBLISHER;}
 writeFileSync(join(directory,'vss-extension.json'),JSON.stringify(manifest,null,2)+'\n');
 const task=join(directory,'task');populate(task);
 for(const file of ['task.json'])cpSync(join(root,'integrations/azure-pipelines/task',file),join(task,file));
 mkdirSync(join(task,'platform'),{recursive:true});
 cpSync(join(root,'integrations/platform/entry.cjs'),join(task,'platform/entry.cjs'));
 for(const name of ['main','post'])writeFileSync(join(task,name+'.cjs'),"'use strict';\nrequire('./platform/entry.cjs')."+name+"('azure').catch(()=>{console.error('Device Farm task "+name+" failed');process.exitCode=1;});\n");
 verifyPayload(directory,allowed);
 return directory;
}
export function stagePipe(){
 const directory=join(root,'integrations/bitbucket-pipe/build/context');
 const allowed=new Set([...Object.keys(sources),'Dockerfile','pipe.yml','entrypoint.sh']);verifyPayload(directory,allowed);populate(directory);
 for(const file of ['Dockerfile','pipe.yml','entrypoint.sh'])cpSync(join(root,'integrations/bitbucket-pipe',file),join(directory,file));
 verifyPayload(directory,allowed);
 return directory;
}
export function main(mode){
 if(mode==='circleci'){
  const target=join(root,'integrations/circleci/orb.yml'),source=orb();
  if(process.argv.includes('--check')){if(readFileSync(target,'utf8')!==source)throw new Error('Orb bundle is stale');}
  else writeFileSync(target,source);
  console.log('CircleCI Orb bundle verified');return;
 }
 if(mode==='bitbucket'){console.log(stagePipe());return;}
 if(mode==='azure'||mode==='azure-stage'){
  const directory=stageAzure();if(mode==='azure-stage'){console.log(directory);return;}
  const tool=join(root,'integrations/azure-pipelines/node_modules/tfx-cli/_build/tfx-cli.js');
  if(!existsSync(tool))throw new Error('Run npm ci in integrations/azure-pipelines');
  const output=join(root,'integrations/azure-pipelines/build/distributions');mkdirSync(output,{recursive:true});
  const result=spawnSync(process.execPath,[tool,'extension','create','--manifest-globs','vss-extension.json','--output-path',output,'--no-prompt'],{cwd:directory,stdio:'inherit'});
  if(result.status!==0)throw new Error('Azure VSIX packaging failed');return;
 }
 throw new Error('Use circleci, bitbucket, azure-stage or azure');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{main(process.argv[2]);}catch(error){console.error(error.message);process.exitCode=1;}
}
