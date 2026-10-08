import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({entryPoints:[fileURLToPath(new URL('./src/permissions.tsx',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {can,togglePermission} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
test('permission toggles add prerequisites recursively and remove dependent actions',()=>{
 const grants=togglePermission([],'roles.manage',true);
 assert.ok(grants.includes('roles.view'));assert.ok(grants.includes('users.view'));
 assert.ok(!togglePermission(grants,'roles.view',false).includes('roles.manage'));
 const sessions=togglePermission([],'sessions.manageAll',true);
 assert.deepEqual(sessions,['sessions.view','sessions.viewAll','sessions.manageAll']);
 assert.deepEqual(togglePermission(sessions,'sessions.view',false),[]);
 assert.equal(can({role:'admin',permissions:[]},'roles.manage'),false);
 assert.equal(can({role:'user',roleId:'custom'},'sessions.create'),false);
 assert.equal(can({role:'user'},'sessions.create'),true);
});
