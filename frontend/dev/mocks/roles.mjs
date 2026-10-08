import { readFileSync } from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../../../shared/permissions.json',import.meta.url),'utf8'));
const messages=JSON.parse(readFileSync(new URL('../../../shared/messages.json',import.meta.url),'utf8'));
const roles=[
 {id:'00000000-0000-4000-8000-000000000001',name:'Administrator',builtin:'admin',permissions:catalog.groups.flatMap(group=>group.actions.map(action=>action.id))},
 {id:'00000000-0000-4000-8000-000000000002',name:'User',builtin:'user',permissions:catalog.user},
];
export function setMockRole(person, roleId) {
 const role=roles.find(item=>item.id===roleId)||roles.find(item=>item.builtin===person.role)||roles[1];
 Object.assign(person,{role:role.builtin==='admin'?'admin':'user',roleId:role.id,roleName:role.name,roleBuiltin:role.builtin});
 return role;
}
export default function roleMock(req,res,path,method,state,send) {
 if(!path.startsWith('/admin/roles') && !/^\/admin\/users\/[^/]+\/role$/.test(path)) return false;
 for(const person of state.adminUsers) setMockRole(person,person.roleId);
 const fail=(status,key)=>send(res,status,{error:{message:messages[key].en}});
 if(path==='/admin/roles' && method==='GET') {
  send(res,200,{roles:roles.map(role=>({...role,userCount:state.adminUsers.filter(person=>person.roleId===role.id).length})),catalog:catalog.groups});return true;
 }
 if(method==='DELETE') {
  const id=path.split('/')[3],role=roles.find(role=>role.id===id);
  if(!role) fail(404,'roles.notFound');else if(role.builtin) fail(409,'roles.protected');
  else if(state.adminUsers.some(person=>person.roleId===id)) fail(409,'roles.inUse');
  else {roles.splice(roles.indexOf(role),1);send(res,200,{ok:true});}
  return true;
 }
 let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
  const body=JSON.parse(raw||'{}');
  if(method==='PUT') {
   const person=state.adminUsers.find(person=>person.id===path.split('/')[3]);
   if(!person||!roles.some(role=>role.id===body.roleId)) return fail(404,'roles.notFound');
   const role=setMockRole(person,body.roleId);
   if(person.id===state.user.id) Object.assign(state.user,person,{permissions:role.permissions});
   return send(res,200,{ok:true});
  }
  if(!body.name?.trim()||!Array.isArray(body.permissions)) return fail(400,'roles.invalid');
  const id=path.split('/')[3],previous=roles.find(role=>role.id===id);
  if(previous?.builtin==='admin') return fail(409,'roles.protected');
  if(roles.some(role=>role.id!==id&&role.name.toLowerCase()===body.name.trim().toLowerCase())) return fail(409,'roles.exists');
  const role=previous||{id:crypto.randomUUID(),builtin:null};
  Object.assign(role,{name:body.name.trim(),permissions:body.permissions});
  if(!previous) roles.push(role);
  send(res,previous?200:201,{role});
 });return true;
}
