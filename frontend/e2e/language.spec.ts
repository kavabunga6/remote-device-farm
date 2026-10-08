import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
test.beforeEach(({page}) => { page.on('pageerror', error => console.error(error.stack)); });

for(const language of ['ru','en'] as const) for(const theme of ['light','dark'] as const) {
 test(`desktop language coverage ${language} ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.addInitScript(lang=>localStorage.setItem('rdf.language',lang),language);
  await page.route('**/api/me/preferences',route=>route.fulfill({json:{preferences:{theme,fontScale:1.25,fontFamily:'system',defaultAdbKeyId:null}}}));
  await page.goto('/#/overview');
  await expect(page.locator('html')).toHaveAttribute('lang',language);
  await expect(page.getByRole('heading',{name:language==='en'?'Sessions':'Сессии',exact:true,level:1})).toBeVisible();
  await expect(page.locator('.sidebar .language-control')).toHaveCount(0);
  await page.getByRole('button',{name:language==='en'?'New session':'Новая сессия',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:language==='en'?'New session':'Новая сессия',exact:true})).toBeVisible();
  await expect(dialog.getByText(language==='en'?'GPU acceleration':'Ускорение GPU',{exact:true}).first()).toBeVisible();
  await expect(dialog.getByRole('button',{name:language==='en'?'Cancel':'Отмена',exact:true})).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  await dialog.locator('.button.primary').evaluate(async button => { getComputedStyle(button).backgroundColor; await Promise.all(button.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const overflow=await dialog.evaluate(element=>element.scrollWidth>element.clientWidth+1);
  expect(overflow).toBe(false);
  await page.screenshot({path:fileURLToPath(new URL(`../../.tmp-ui/localization-${language}-${theme}.png`,import.meta.url)),fullPage:true});
  await dialog.getByRole('button',{name:language==='en'?'Cancel':'Отмена',exact:true}).click();
  await page.goto('/#/admin/users');
  await expect(page.getByRole('heading',{name:language==='en'?'Users':'Пользователи',exact:true,level:1})).toBeVisible();
  await expect(page.locator('.page-heading .count-badge')).toHaveCount(0);
  await page.goto('/#/account/appearance');
  await expect(page.getByRole('button',{name:language==='en'?'Appearance':'Оформление',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:language==='en'?'Password and security':'Пароль и безопасность',exact:true})).toBeVisible();
  const switcher=page.getByRole('radiogroup',{name:language==='en'?'Interface language':'Язык интерфейса'});
  await expect(switcher.getByRole('radio')).toHaveCount(2);
  await expect(switcher.getByRole('radio',{name:language==='en'?'English':'Русский',exact:true})).toBeChecked();
 });
}

test('switching language in settings preserves a device open in another tab',async({page,context})=>{
 let stopped=0;
 await page.route('**/api/sessions/*',async route=>{if(route.request().method()==='DELETE')stopped++;await route.continue();});
 await page.goto('/');
 await page.locator('.session-card').first().getByRole('link',{name:/Открыть сессию:/}).click();
 await expect(page.getByRole('application',{name:'Сенсорный экран устройства'})).toBeVisible();
 const id=page.url();
 const settings=await context.newPage();
 await settings.goto('/#/account/appearance');
 await settings.getByRole('radio',{name:'English',exact:true}).click();
 await expect(settings.getByRole('radio',{name:'English',exact:true})).toBeChecked();
 await expect(page.getByRole('tab',{name:'Environment',exact:true})).toBeVisible();
 await expect(page.getByRole('tab',{name:'Information',exact:true})).toBeVisible();
 await expect(page.getByRole('application',{name:'Device touch screen'})).toBeVisible();
 expect(page.url()).toBe(id);expect(stopped).toBe(0);
 await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');
 await settings.close();
});

test('sign-in language control remains usable before authentication',async({page})=>{
 await page.route('**/api/me',route=>route.fulfill({json:{user:null}}));
 await page.goto('/');await page.getByRole('combobox',{name:'Язык интерфейса'}).selectOption('en');
 await expect(page.getByRole('heading',{name:'Sign in to DeviceFarm'})).toBeVisible();
 await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
});


test('persisted server failure translates with its identity and survives live language changes', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('rdf.language','en'));
  await page.route('**/api/me/notifications', route => route.fulfill({json:{notifications:[{
    id:'i18n-failure',sessionId:'language-session',kind:'session.failed',
    title:'Не удалось запустить устройство',
    body:'Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.',
    createdAt:new Date().toISOString()
  }]}}));
  await page.route('**/api/me/notifications/read',route=>route.fulfill({json:{marked:1}}));
  await page.goto('/#/overview');
  const toast=page.locator('.notification-error');
  await expect(toast.locator('.notification-title')).toHaveText('Could not start device');
  await expect(toast.locator('.notification-message')).toHaveText('Session #language. The emulator exited before Android finished booting. Check the image and launch options.');
  await page.evaluate(()=>{window.location.hash='/account/appearance';});
  await page.getByRole('radio',{name:'Русский',exact:true}).click();
  await expect(toast.locator('.notification-title')).toHaveText('Не удалось запустить устройство');
  await expect(toast.locator('.notification-message')).toHaveText('Сессия #language. Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.');
  await expect(toast.getByRole('button',{name:'Закрыть уведомление: Не удалось запустить устройство'})).toBeVisible();
});

test('English copy covers every administrative section and image-builder controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rdf.language','en'));
  await page.route('**/api/me/notifications',route=>route.fulfill({json:{notifications:[]}}));
  for (const [route,heading] of [['nodes','Nodes'],['profiles','Device profiles'],['users','Users'],['sessions','All sessions'],['ops','Capacity'],['journal','Journal']]) {
    await page.goto('/#/admin/'+route);
    await expect(page.getByRole('heading',{name:heading,level:1,exact:true})).toBeVisible();
    expect(await page.locator('.page-heading').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  }
  await page.goto('/#/admin/profiles');
  await page.getByRole('button',{name:'Image catalog',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'Google image catalog',exact:true})).toBeVisible();
  await expect(dialog.getByText('Builder node',{exact:true})).toBeVisible();
  await expect(dialog.getByLabel('Built-in registry',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Save settings',exact:true})).toBeVisible();
});
