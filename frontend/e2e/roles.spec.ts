import { expect, test, type Page } from '@playwright/test';
import catalog from '../../shared/permissions.json' with {type:'json'};
import messages from '../../shared/messages.json' with {type:'json'};
const ADMIN='00000000-0000-4000-8000-000000000001', USER='00000000-0000-4000-8000-000000000002';
const all=catalog.groups.flatMap(group=>group.actions.map(action=>action.id));
async function fixture(page:Page, {theme='light',scale=1,language='en',permissions=all}:{theme?:string;scale?:number;language?:string;permissions?:string[]}={}) {
 const roles=[
  {id:ADMIN,name:'Administrator',builtin:'admin',permissions:all,userCount:1},
  {id:USER,name:'User',builtin:'user',permissions:catalog.user,userCount:1},
 ];
 const users=[
  {id:'root',username:'admin',displayName:'Admin',provider:'local',role:'admin',roleId:ADMIN,roleName:'Administrator',roleBuiltin:'admin',createdAt:'2026-01-01T00:00:00Z'},
  {id:'reader',username:'reader',displayName:'Reader',provider:'ldap',role:'user',roleId:USER,roleName:'User',roleBuiltin:'user',createdAt:'2026-02-01T00:00:00Z'},
 ];
 const actor={id:'u1',username:'admin',displayName:'Admin',role:permissions===all?'admin':'user',roleId:permissions===all?ADMIN:'custom',permissions};
 await page.addInitScript(language=>localStorage.setItem('rdf.language',language),language);
 await page.route('**/api/me',route=>route.fulfill({json:{user:actor}}));
 await page.route('**/api/me/preferences',route=>route.fulfill({json:{preferences:{theme,fontScale:scale,fontFamily:'system',defaultAdbKeyId:null}}}));
 await page.route(/\/api\/admin\/roles(?:\/[^/?]+)?(?:\?.*)?$/,async route=>{
  const request=route.request(), id=new URL(request.url()).pathname.split('/')[4];
  if(request.method()==='GET') return route.fulfill({json:{roles:roles.map(role=>({...role,userCount:users.filter(user=>user.roleId===role.id).length})),catalog:catalog.groups}});
  if(request.method()==='POST') {roles.push({id:'custom-role',builtin:null as never,userCount:0,...request.postDataJSON()});return route.fulfill({status:201,json:{role:roles.at(-1)}});}
  const index=roles.findIndex(role=>role.id===id);
  if(request.method()==='PATCH'){Object.assign(roles[index]!,request.postDataJSON());return route.fulfill({json:{role:roles[index]}});}
  if(users.some(user=>user.roleId===id)) return route.fulfill({status:409,json:{error:{message:messages['roles.inUse'][language as 'en'|'ru']}}});
  roles.splice(index,1);return route.fulfill({json:{ok:true}});
 });
 await page.route('**/api/admin/users',route=>route.fulfill({json:{users}}));
 await page.route('**/api/admin/users/*/role',route=>{
  const id=new URL(route.request().url()).pathname.split('/')[4];
  const role=roles.find(role=>role.id===route.request().postDataJSON().roleId)!;
  Object.assign(users.find(user=>user.id===id)!,{role:role.builtin==='admin'?'admin':'user',roleId:role.id,roleName:role.name,roleBuiltin:role.builtin});
  return route.fulfill({json:{ok:true}});
 });
 return {roles,users};
}
test('administrator creates, edits, assigns and deletes roles; required view grants follow actions',async({page})=>{
 test.setTimeout(60000);
 await fixture(page);await page.goto('/#/admin/roles');
 await expect(page.getByRole('heading',{name:'Roles and permissions',exact:true,level:1})).toBeVisible();
 await page.getByRole('button',{name:'New role',exact:true}).click();
 await page.getByRole('textbox',{name:'Role name',exact:true}).fill('Observer');
 await page.getByRole('checkbox',{name:'Configure, sanitize devices and remove nodes',exact:true}).check();
 await expect(page.getByRole('checkbox',{name:messages['permissions.nodes.view'].en,exact:true})).toBeChecked();
 await page.getByRole('checkbox',{name:messages['permissions.nodes.view'].en,exact:true}).uncheck();
 await expect(page.getByRole('checkbox',{name:'Configure, sanitize devices and remove nodes',exact:true})).not.toBeChecked();
 await page.getByRole('checkbox',{name:messages['permissions.nodes.view'].en,exact:true}).check();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.locator('.role-list').getByRole('button',{name:/^Observer/})).toBeVisible();
 await page.goto('/#/admin/users');
 await page.getByRole('button',{name:'Assign role · reader',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Assign role',exact:true});
 await dialog.getByRole('combobox',{name:'Choose a role',exact:true}).selectOption('custom-role');
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.locator('.user-record').filter({hasText:'reader'})).toContainText('Observer');
 await page.goto('/#/admin/roles');await page.locator('.role-list').getByRole('button',{name:/^Observer/}).click();
 await page.getByRole('button',{name:'Delete role',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:messages['roles.delete'].en,exact:true}).click();
 await expect(page.getByRole('alertdialog').getByRole('alert')).toHaveText(messages['roles.inUse'].en);
 await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
 await page.goto('/#/admin/users');await page.getByRole('button',{name:'Assign role · reader',exact:true}).click();
 await dialog.getByRole('combobox',{name:'Choose a role',exact:true}).selectOption(USER);
 await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).toHaveCount(0);
 await page.goto('/#/admin/roles');await page.locator('.role-list').getByRole('button',{name:/^Observer/}).click();
 await page.getByRole('button',{name:'Delete role',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:messages['roles.delete'].en,exact:true}).click();
 await expect(page.locator('.role-list').getByRole('button',{name:/^Observer/})).toHaveCount(0);
});
test('custom observer sees allowed sections without mutation controls or forbidden direct routes',async({page})=>{
 await fixture(page,{permissions:['roles.view','users.view','nodes.view','sessions.view']});
 await page.goto('/#/admin/users');await expect(page.locator('.user-record')).toHaveCount(2);
 await expect(page.locator('.user-record-actions button')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'New user',exact:true})).toHaveCount(0);
 await page.goto('/#/admin/roles');await expect(page.locator('.role-list button')).toHaveCount(2);
 await expect(page.getByRole('button',{name:'New role',exact:true})).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'Role name',exact:true})).toBeDisabled();
 await page.goto('/#/admin/profiles');
 await expect(page.getByRole('heading',{name:'Sessions',level:1,exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'New session',exact:true})).toHaveCount(0);
 await expect(page.locator('.session-card-release')).toHaveCount(0);
});
for(const [width,theme,scale,language] of [[1366,'light',1,'ru'],[1440,'dark',1,'en'],[1000,'dark',1.25,'ru']] as const) {
 test(`roles controls stay aligned on desktop ${width} ${theme} ${scale} ${language}`,async({page})=>{
  await page.setViewportSize({width,height:950});await fixture(page,{theme,scale,language});await page.goto('/#/admin/roles');
  await expect(page.locator('.role-editor')).toBeVisible();await page.evaluate(()=>document.fonts.ready);
  await page.locator('#page-heading-actions button').click();
  await expect(page.locator('.role-management .section-heading')).toHaveCount(0);
  await expect(page.locator('.role-management .registration-settings')).toHaveCount(0);
  const metrics=await page.locator('.permission-groups').evaluate(element=>{
   const groups=Array.from(element.querySelectorAll('fieldset')).map(group=>Array.from(group.querySelectorAll('input')).map(input=>input.getBoundingClientRect().left));
   return {width:document.documentElement.scrollWidth,viewport:window.innerWidth,groups,visible:element.querySelectorAll('input').length};
  });
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.visible).toBe(all.length);
  for(const group of metrics.groups) expect(Math.max(...group)-Math.min(...group)).toBeLessThanOrEqual(1);
  const field=page.locator('.role-name input');expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({path:`../.tmp-ui/roles/${width}-${theme}-${scale}-${language}.png`,animations:'disabled'});
 });
}

test('device tools follow grants and never poll forbidden ADB, environment or Logcat APIs',async({page})=>{
 await fixture(page,{permissions:['sessions.view','sessions.control']});
 const forbidden:string[]=[];
 page.on('request',request=>{if(/\/api\/(?:me\/adb-|sessions\/[^/]+\/(?:adb|env|logcat))/.test(request.url())) forbidden.push(request.url());});
 await page.goto('/#/overview');await expect(page.locator('.session-card').first()).toBeVisible();
 await page.locator('.session-card').first().getByRole('link').first().click();
 await expect(page.locator('.tool-tabs [role=tab]')).toHaveCount(1);
 await expect(page.locator('.tool-tabs [role=tab]')).toHaveAttribute('id','tool-tab-info');
 await expect(page.locator('.adb-title-control, .upload-control')).toHaveCount(0);
 await expect(page.locator('.terminal-tool')).not.toBeVisible();
 expect(forbidden).toEqual([]);
});
