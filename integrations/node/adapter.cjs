'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const names = ['url','profile','adbKeyId','testScript','prepareScript','environmentScript','artifactsDirectory','tokenVariable','adbKeyFile','caFile','startTimeoutSeconds','testTimeoutSeconds','junitReport','label'];
function configure(values) {
  if (Object.keys(values).some(name => !names.includes(name))) throw new Error('Unknown CI option');
  const options = { testScript:'ci/android-tests.sh', prepareScript:'', environmentScript:'', artifactsDirectory:'rdf-artifacts', tokenVariable:'RDF_TOKEN',
    adbKeyFile:'', caFile:'', startTimeoutSeconds:'900', testTimeoutSeconds:'1200', junitReport:'app/build/outputs/androidTest-results/connected/**/*.xml', label:'ci-tests', ...values };
  for (const value of Object.values(options)) if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('CI values must be single-line strings');
  for (const name of ['url','profile','adbKeyId','testScript']) if (!options[name].trim()) throw new Error('Required CI option is missing');
  if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(options.adbKeyId)) throw new Error('Use a public ADB key UUID');
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || !['https:','http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use a verified HTTPS service URL');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenVariable)) throw new Error('Invalid token variable name');
  for (const name of ['testScript','prepareScript','environmentScript','artifactsDirectory','junitReport']) {
    const value = options[name];
    if (value && (path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..'))) throw new Error('CI paths must stay inside the checkout');
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(options.artifactsDirectory) || options.artifactsDirectory === '.') throw new Error('Invalid artifacts directory');
  for (const name of ['startTimeoutSeconds','testTimeoutSeconds']) if (!/^[1-9][0-9]{0,4}$/.test(options[name]) || Number(options[name]) > 86400) throw new Error('CI timeout must be 1-86400 seconds');
  return options;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function reports(workspace, options, directory, since) {
  const pattern=options.junitReport;
  if (!pattern) return;
  const regex=new RegExp('^'+pattern.split('/').map(part=>part==='**'?'(?:[^/]+/)*':part.replace(/[.+^$${()|[\]\\]/g,'\\$&').replaceAll('*','[^/]*').replaceAll('?','[^/]')).join('/').replaceAll('(?:[^/]+/)*/','(?:[^/]+/)*')+'$');
  let visited=0, copied=0;
  const artifacts=path.resolve(workspace,options.artifactsDirectory);
  function visit(folder) {
    for(const item of fs.readdirSync(folder,{withFileTypes:true})){
      if(++visited>100000)throw new Error('Report search limit exceeded');
      const file=path.join(folder,item.name);
      if(file===artifacts||item.isSymbolicLink()||item.name==='.git'||item.name==='node_modules')continue;
      if(item.isDirectory())visit(file);
      else if(item.isFile()&&item.name.endsWith('.xml')&&regex.test(path.relative(workspace,file).split(path.sep).join('/'))){
        const stat=fs.statSync(file);if(stat.mtimeMs<since-1000)continue;
        if(++copied>10000||stat.size>10*1024*1024)throw new Error('JUnit report limit exceeded');
        const target=path.join(directory,'junit',path.relative(workspace,file));fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(file,target);fs.chmodSync(target,0o600);
      }
    }
  }
  const parts=pattern.split('/'),wildcard=parts.findIndex(part=>/[?*]/.test(part));
  const prefix=parts.slice(0,wildcard===-1?parts.length-1:wildcard).join('/');
  const start=path.resolve(workspace,prefix);
  if(!fs.existsSync(start)||!fs.lstatSync(start).isDirectory()||start===artifacts||inside(artifacts,start))return;
  const real=fs.realpathSync(start);if(real!==workspace&&!inside(workspace,real))return;
  visit(start);
}
function directoryInside(workspace,directory){
  if(!inside(workspace,directory))throw new Error('Directory leaves the checkout');
  let existing=directory;while(!fs.existsSync(existing))existing=path.dirname(existing);
  const real=fs.realpathSync(existing);if(real!==workspace&&!inside(workspace,real))throw new Error('Directory leaves the checkout');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(!inside(workspace,fs.realpathSync(directory)))throw new Error('Directory leaves the checkout');
}
function shellPath(value) { return process.platform==='win32' ? value.replaceAll('\\','/') : value; }
function environment(options, directory, tools, inherited, requireToken = true) {
  if (requireToken && !inherited[options.tokenVariable]) throw new Error('Configured API token is missing');
  return { ...inherited, RDF_URL:options.url, RDF_PROFILE:options.profile, RDF_ADB_KEY_ID:options.adbKeyId,
    RDF_TEST_SCRIPT:options.testScript, RDF_PREPARE_SCRIPT:options.prepareScript, RDF_ENV_SCRIPT:options.environmentScript,
    RDF_ARTIFACT_DIR:shellPath(directory), RDF_STATE_FILE:shellPath(path.join(directory,'session.json')), RDF_TOKEN_VARIABLE:options.tokenVariable,
    RDF_ADB_KEY_FILE:options.adbKeyFile, RDF_CA_FILE:options.caFile, RDF_START_TIMEOUT_SECONDS:options.startTimeoutSeconds,
    RDF_TEST_TIMEOUT_SECONDS:options.testTimeoutSeconds, RDF_LABEL:options.label, RDF_TOOL_DIR:shellPath(tools) };
}
async function command(mode, cwd, tools, env, hooks = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(hooks.bash || 'bash', [shellPath(path.join(tools,'native-entry.sh')), mode], {cwd,env,stdio:'inherit',detached:process.platform !== 'win32'});
    let signalled = 0;
    const signal = number => () => { signalled = number; try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const term = signal(143), interrupt = signal(130);
    process.on('SIGTERM', term); process.on('SIGINT', interrupt);
    child.once('error', error => { process.removeListener('SIGTERM',term);process.removeListener('SIGINT',interrupt); reject(new Error('CI runtime could not start')); });
    child.once('close', code => { process.removeListener('SIGTERM',term);process.removeListener('SIGINT',interrupt);resolve(signalled || code || (code === 0 ? 0 : 1)); });
  });
}
async function run(values, context = {}) {
  const options = configure(values);
  if ((context.platform || process.platform) !== 'linux') throw new Error('A Linux CI worker is required');
  const workspace = fs.realpathSync(context.workspace || process.cwd());
  const parent = path.resolve(workspace,options.artifactsDirectory);
  directoryInside(workspace,parent);
  const directory = path.join(parent,randomUUID());fs.mkdirSync(directory,{mode:0o700});
  const tools = context.tools || path.resolve(__dirname,'..','common');
  const metadata = {format:1,workspace,options,code:null,createdAt:Date.now()};
  fs.writeFileSync(path.join(directory,'ci-run.json'),JSON.stringify(metadata),{mode:0o600});
  context.state?.(directory);
  context.output?.('artifacts-directory',directory);
  const env = environment(options,directory,tools,context.env || process.env);
  let code = 1;
  try { code = await command('run',workspace,tools,env,context); }
  finally { metadata.code=code;fs.writeFileSync(path.join(directory,'ci-run.json'),JSON.stringify(metadata),{mode:0o600}); }
  try { reports(workspace,options,directory,metadata.createdAt); } catch { code=code||1; console.error('JUnit collection failed'); }
  return {code,directory};
}
async function recover(directory, context = {}) {
  if (!directory) return {code:0};
  const workspace = fs.realpathSync(context.workspace || process.cwd());
  if (!inside(workspace,path.resolve(directory)) || !/^[0-9a-f-]{36}$/.test(path.basename(directory)) || !fs.existsSync(path.join(directory,'ci-run.json'))) throw new Error('Invalid CI recovery directory');
  const file=path.join(directory,'ci-run.json');
  if(!fs.lstatSync(file).isFile()||!inside(fs.realpathSync(directory),fs.realpathSync(file)))throw new Error('Invalid recovery metadata');
  const metadata = JSON.parse(fs.readFileSync(file,'utf8'));
  if (metadata.format !== 1 || metadata.workspace !== workspace || !inside(workspace,fs.realpathSync(directory))) throw new Error('Recovery state belongs to another checkout');
  const credentials=Object.fromEntries(Object.entries(context.credentialFiles||{}).filter(([name,value])=>['adbKeyFile','caFile'].includes(name)&&typeof value==='string'&&value));
  const options = configure({...metadata.options,...credentials}), tools = context.tools || path.resolve(__dirname,'..','common');
  const code = await command('recover',workspace,tools,environment(options,directory,tools,context.env || process.env,false),context);
  let result=code;try { reports(workspace,options,directory,metadata.createdAt||Date.now()); } catch { result=result||1;console.error('JUnit collection failed'); }
  return {code:result,directory,originalCode:metadata.code};
}
module.exports = {configure,run,recover,inside,reports,directoryInside};
