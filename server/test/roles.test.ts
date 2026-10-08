import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import type { AgentHub } from '../src/agent.js';
import { AuthService, newToken, tokenHash } from '../src/auth.js';
import { installAuditTrail } from '../src/audit.js';
import { migrate } from '../src/db.js';
import { ApiError } from '../src/http-common.js';
import { createServerContext } from '../src/server-context.js';
import { registerAdminRoutes } from '../src/routes/admin-routes.js';
import { registerEnvRoutes } from '../src/routes/env-routes.js';
import { registerSessionRoutes } from '../src/routes/session-routes.js';
import { allPermissions, hasPermission, parsePermissions, permissionCatalog } from '../src/permissions.js';
import { launchOverridesAllowed } from '../src/launch-permissions.js';
import { requestPermission } from '../src/request-permissions.js';
import { registerAccessResource } from '../src/access-connections.js';

const ADMIN = '00000000-0000-4000-8000-000000000001', USER = '00000000-0000-4000-8000-000000000002';
const uuid = () => crypto.randomUUID();
test('permission catalogue rejects unknown and incomplete grants; routes cover alternate spelling', () => {
 assert.equal(new Set(allPermissions).size, allPermissions.length);
 assert.deepEqual(parsePermissions([]), []);
 assert.throws(() => parsePermissions(['unknown']));
 assert.throws(() => parsePermissions(['roles.manage']));
 assert.throws(() => parsePermissions(['sessions.manageAll','sessions.view']));
 assert.equal(hasPermission({ role:'user', roleId:uuid() }, 'sessions.create'), false);
 assert.equal(hasPermission({ role:'admin', permissions:[] }, 'users.manage'), false);
 for (const group of permissionCatalog.groups) for (const action of group.actions) {
  for (const prerequisite of action.requires) assert.ok(allPermissions.includes(prerequisite));
 }
 for (const [method,path,permission] of [
  ['POST','/api/sessions','sessions.create'], ['POST','/API/Sessions/','sessions.create'],
  ['POST','/api/admin/users/id/password/','users.password'],
  ['PUT','/api/admin/users/id/role/','roles.manage'],
  ['POST','/api/sessions/id/adb','sessions.console'],
  ['GET','/api/sessions/id/adb-port','sessions.adb'],
  ['POST','/api/sessions/id/env','sessions.env'],
  ['POST','/api/sessions/id/files','sessions.files'],
  ['GET','/api/sessions/id/logcat','sessions.logcat'],
  ['DELETE','/api/sessions/id','sessions.stop'],
  ['POST','/api/admin/emulator-images/build','images.build'],
  ['PATCH','/api/admin/registry','images.settings'],
 ]) assert.equal(requestPermission(method!,path!), permission);
});

test('roles persist, enforce API grants, preserve external assignments and revoke active access', async t => {
 const db = new PGlite();
 const query = async (sql:string, params?:unknown[]) => {
  const result = params === undefined ? (await db.exec(sql)).at(-1)! : await db.query(sql,params);
  return {...result,rowCount:result.rows.length || result.affectedRows || 0};
 };
 const client={query,release(){}}, pool={query,connect:async()=>client} as unknown as Pool;
 let server:ReturnType<typeof createServer>|undefined;
 try {
  await migrate(pool);
  const config={authMode:'local', localAdminUsername:'root', localAdminPassword:'initial-password-123', adminSubjects:new Set(), secureCookies:false, maxSessionsPerUser:3} as Config;
  const auth = new AuthService(pool,config); await auth.bootstrap();
  const root = (await query("SELECT id FROM users WHERE username='root'")).rows[0].id as string;
  const reader = uuid();
  await query("INSERT INTO users(id,provider,subject,username,display_name,role) VALUES($1,'local','reader','reader','Reader','user')",[reader]);
  const cookie=async(userId:string)=>{
   const raw=newToken(); await query("INSERT INTO browser_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[uuid(),userId,tokenHash(raw)]);
   return 'rdf_session='+raw;
  };
  const rootCookie=await cookie(root), readerCookie=await cookie(reader);
  const app=express(); app.use(express.json()); installAuditTrail(app,pool);
  const context=createServerContext(pool,config,auth,undefined,{} as AgentHub);
  registerAdminRoutes(app,context); registerSessionRoutes(app,context); registerEnvRoutes(app,context);
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
   if(error instanceof ApiError) res.status(error.status).json({code:error.code});
   else {console.error(error);res.status(500).json({code:'internal'});}
  });
  server=createServer(app); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const request=(path:string,method='GET',body?:unknown,credential=rootCookie)=>fetch('http://127.0.0.1:'+address.port+'/api'+path,{method,headers:{Cookie:credential,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let roleId='';
  await t.test('catalogue and CRUD guard protected roles, duplicates and prerequisites',async()=>{
   const list=await request('/admin/roles');assert.equal(list.status,200);
   const payload=await list.json(); assert.equal(payload.roles.length,2);assert.equal(payload.catalog.length,permissionCatalog.groups.length);
   assert.deepEqual(payload.roles.find((r:{id:string})=>r.id===ADMIN).permissions,allPermissions);
   assert.equal((await request('/admin/roles','POST',{name:'Bad',permissions:['users.manage']})).status,400);
   const created=await request('/admin/roles','POST',{name:'Observer',permissions:['nodes.view','users.view','sessions.view','tokens.personal']});
   assert.equal(created.status,201); roleId=(await created.json()).role.id;
   assert.equal((await request('/admin/roles','POST',{name:'observer',permissions:[]})).status,409);
   assert.equal((await request('/admin/roles/'+ADMIN,'PATCH',{name:'Admin',permissions:[]})).status,409);
   assert.equal((await request('/admin/roles/'+USER,'PATCH',{name:'Renamed',permissions:[]})).status,409);
   for(const id of [ADMIN,USER]) assert.equal((await request('/admin/roles/'+id,'DELETE')).status,409);
  });
  await t.test('assignment takes effect for existing browser and personal API token',async()=>{
   await query("INSERT INTO api_tokens(id,owner_user_id,kind,name,token_hash) VALUES($1,$2,'personal','Reader',$3)",[uuid(),reader,tokenHash('reader-token')]);
   assert.equal((await request('/admin/users/'+reader+'/role','PUT',{roleId},readerCookie)).status,403);
   assert.equal((await request('/admin/users/'+reader+'/role','PUT',{roleId})).status,200);
   assert.equal((await request('/hosts','GET',undefined,readerCookie)).status,200);
   assert.equal((await request('/admin/users','GET',undefined,readerCookie)).status,200);
   assert.equal((await request('/admin/roles','GET',undefined,readerCookie)).status,403);
   assert.equal((await request('/admin/users','POST',{username:'escalated',password:'long-password-123',role:'admin'},readerCookie)).status,403);
   assert.equal((await request('/sessions/','POST',{profileId:'android-30'},readerCookie)).status,403);
   assert.equal((await request('/SESSIONS','POST',{},readerCookie)).status,403);
   const bearer=await auth.authenticate({headers:{authorization:'Bearer reader-token'}} as never);
   assert.ok(bearer); assert.equal(hasPermission(bearer.user,'nodes.view'),true);assert.equal(hasPermission(bearer.user,'sessions.create'),false);
   assert.equal((await request('/admin/roles/'+roleId,'DELETE')).status,409);
  });
  await t.test('editing a role closes active resources, invalidates ADB leases and queued launches',async()=>{
   const session=uuid();
   await query("INSERT INTO hosts(id,name) VALUES('role-host','Host')");
   await query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'role-host','android-30','running')",[session,reader]);
   const foreign=uuid();
   await query("INSERT INTO sessions(id,owner_user_id,host_id,profile_id,state) VALUES($1,$2,'role-host','android-30','running')",[foreign,root]);
   assert.equal((await request('/sessions/'+foreign,'GET',undefined,readerCookie)).status,404);
   assert.equal((await request('/admin/roles/'+roleId,'PATCH',{name:'Observer',permissions:['sessions.view','sessions.viewAll']})).status,200);
   const viewed=await request('/sessions/'+foreign,'GET',undefined,readerCookie);
   assert.equal(viewed.status,200);assert.equal((await viewed.json()).session.access,'view');
   assert.equal((await request('/sessions/'+foreign+'/input','POST',{kind:'tap',x:10,y:10},readerCookie)).status,403);
   await query("INSERT INTO adb_access_tokens(token_hash,session_id,owner_user_id,expires_at) VALUES('access',$1,$2,now()+interval '1 hour')",[session,reader]);
   await query("INSERT INTO queue_entries(id,user_id,profile_id,expires_at) VALUES($1,$2,'android-30',now()+interval '1 hour')",[uuid(),reader]);
   let closed=0; const detach=registerAccessResource(reader,()=>closed++);
   assert.equal((await request('/admin/roles/'+roleId,'PATCH',{name:'Observer',permissions:[]})).status,200);
   assert.equal(closed,1);detach();
   assert.equal((await query('SELECT * FROM adb_access_tokens WHERE owner_user_id=$1',[reader])).rows.length,0);
   assert.equal((await query('SELECT state FROM queue_entries WHERE user_id=$1',[reader])).rows[0].state,'cancelled');
   assert.equal((await request('/sessions','GET',undefined,readerCookie)).status,403);
   const token=await auth.authenticate({headers:{authorization:'Bearer reader-token'}} as never);
   assert.equal(hasPermission(token!.user,'nodes.view'),false);
   for(const [method,action] of [['POST','adb'],['POST','adb-access'],['POST','input'],['POST','files'],['POST','env'],['GET','logcat']])
    assert.equal((await request('/sessions/'+session+'/'+action,method,method==='POST'?{}:undefined,readerCookie)).status,403);
  });
  await t.test('directory login preserves explicitly assigned roles and last administrator cannot be demoted',async()=>{
   const external=await auth.upsertExternalUser('oidc','external','external','External');
   assert.equal((await request('/admin/users/'+external.id+'/role','PUT',{roleId})).status,200);
   assert.equal((await auth.upsertExternalUser('oidc','external','external','Updated')).roleId,roleId);
   const response=await request('/admin/users/'+root+'/role','PUT',{roleId:USER});
   assert.equal(response.status,409);assert.equal((await response.json()).code,'last_admin');
  });
  await t.test('password reset cannot take over a stronger account; user creation cannot assign administrator',async()=>{
   assert.equal((await request('/admin/roles/'+roleId,'PATCH',{name:'Observer',permissions:['users.view','users.manage','users.password']})).status,200);
   assert.equal((await request('/admin/users/'+root+'/password','POST',{newPassword:'replacement-password-123'},readerCookie)).status,403);
   assert.equal((await request('/admin/users','POST',{username:'escalated',password:'long-password-123',roleId:ADMIN},readerCookie)).status,403);
   assert.equal((await request('/admin/users','POST',{username:'over-grant',password:'long-password-123'},readerCookie)).status,403);
   assert.equal((await request('/admin/roles/'+roleId,'PATCH',{name:'Observer',permissions:[...permissionCatalog.user,'users.view','users.manage','users.password']})).status,200);
   const created=await request('/admin/users','POST',{username:'new-reader',password:'long-password-123'},readerCookie);
   assert.equal(created.status,201);
   assert.equal((await query("SELECT access_role_id FROM users WHERE username='new-reader'")).rows[0].access_role_id,USER);
   assert.equal((await request('/admin/users/'+reader+'/role','PUT',{roleId:USER})).status,200);
   const external=(await query("SELECT id FROM users WHERE provider='oidc'")).rows[0].id;
   assert.equal((await request('/admin/users/'+external+'/role','PUT',{roleId:USER})).status,200);
   assert.equal((await request('/admin/roles/'+roleId,'DELETE')).status,200);
   assert.equal((await request('/admin/roles/'+roleId,'DELETE')).status,404);
  });
  await t.test('local bootstrap preserves a manually assigned role across restart',async()=>{
   const created=await request('/admin/users','POST',{username:'second-admin',password:'long-password-123',roleId:ADMIN});
   assert.equal(created.status,201);
   assert.equal((await request('/admin/users/'+root+'/role','PUT',{roleId:USER})).status,200);
   await auth.bootstrap();assert.equal((await auth.userById(root))?.roleId,USER);
  });
  await t.test('role mutations and denied assignments appear once in the action journal',async()=>{
   const rows=(await query("SELECT action,outcome,target_id FROM audit_events WHERE action IN ('role.created','role.updated','role.deleted','user.role_changed')")).rows;
   assert.equal(rows.filter(row=>row.action==='role.created'&&row.outcome==='success').length,1);
   assert.ok(rows.some(row=>row.action==='user.role_changed'&&row.outcome==='denied'));
   assert.ok(rows.some(row=>row.action==='role.updated'&&row.outcome==='success'&&row.target_id===roleId));
  });
 } finally {
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  await db.close();
 }
});


test('custom role can restrict ordinary launch overrides even when profile policy allows them', () => {
 const user = { role:'user', roleId:uuid(), permissions:['sessions.view','sessions.create'] };
 assert.equal(launchOverridesAllowed(user, { allow_launch_overrides:true }, true), false);
 const ordinary = { ...user, permissions:[...user.permissions, 'sessions.launchOptions'] };
 assert.equal(launchOverridesAllowed(ordinary, { allow_launch_overrides:true }, false), true);
 assert.equal(launchOverridesAllowed(ordinary, { allow_launch_overrides:false }, true), false);
 const advanced = { ...ordinary, permissions:[...ordinary.permissions, 'sessions.configure'] };
 assert.equal(launchOverridesAllowed(advanced, { allow_launch_overrides:false }, false), true);
 assert.throws(() => parsePermissions(['sessions.configure','sessions.view']));
});
