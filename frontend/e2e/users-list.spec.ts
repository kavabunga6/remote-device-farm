import { expect, test, type Page } from '@playwright/test';
const users = [
  { id: '33333333-3333-4333-8333-333333333333', username: 'yana', displayName: 'Яна', role: 'user', provider: 'local', createdAt: '2026-03-07T09:00:00Z' },
  { id: '22222222-2222-4222-8222-222222222222', username: 'boris', displayName: 'Борис', role: 'admin', provider: 'local', createdAt: '2026-02-04T09:00:00Z' },
  { id: '11111111-1111-4111-8111-111111111111', username: 'anna', displayName: 'Анна', role: 'user', provider: 'ldap', createdAt: '2026-01-02T09:00:00Z' },
];
async function fixture(page: Page, theme='light', scale=1) {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system', defaultAdbKeyId: null } } }));
  await page.route('**/api/admin/users', route => route.fulfill({ json: { users } }));
  await page.goto('/#/admin/users');
  await expect(page.locator('.user-record')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
}
for (const [width,theme,scale] of [[1366,'light',1],[1440,'dark',1],[1366,'dark',1.25]] as const) {
  test(`user list is readable and aligned on desktop ${width} ${theme} ${scale}`, async ({page}) => {
    await page.setViewportSize({width,height:900}); await fixture(page,theme,scale);
    await expect(page.locator('.page-heading .count-badge')).toHaveCount(0);
    const rows=page.locator('.user-record');
    await expect(rows.locator('strong')).toHaveText(['Анна','Борис','Яна']);
    await expect(rows.first()).toContainText('Логин: anna');
    await expect(page.locator('.user-role:not(.is-admin)')).toHaveCount(0);
    await expect(rows.locator('.user-role')).toHaveText(['Администратор']);
    const layout=await rows.evaluateAll(elements=>elements.map(row=>{
      const date=row.querySelector('.user-record-registration')!.getBoundingClientRect();
      const controls=Array.from(row.querySelectorAll('.user-record-actions button')).map(button=>{
        const bounds=button.getBoundingClientRect(); return {top:bounds.top,bottom:bounds.bottom,text:button.textContent};
      });
      return {dateLeft:date.left,dateRight:date.right,time:row.querySelector('time')!.getAttribute('datetime'),controls};
    }));
    expect(layout.every(row=>row.time?.startsWith('2026-'))).toBe(true);
    expect(Math.max(...layout.map(row=>row.dateLeft))-Math.min(...layout.map(row=>row.dateLeft))).toBeLessThanOrEqual(1);
    for (const row of layout) {
      expect(row.controls.every(button=>!button.text?.trim())).toBe(true);
      expect(Math.max(...row.controls.map(button=>button.top))-Math.min(...row.controls.map(button=>button.top))).toBeLessThanOrEqual(1);
      expect(Math.max(...row.controls.map(button=>button.bottom))-Math.min(...row.controls.map(button=>button.bottom))).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('#adm-users')).not.toContainText(/Локальный вход|Вход по паролю|в ферме|на ферме/);
    await page.screenshot({path:`../.tmp-ui/users/${width}-${theme}-${scale}.png`,animations:'disabled'});
    await page.getByLabel('Найти пользователя').fill('яна');
    await expect(rows).toHaveCount(1); await expect(rows).toContainText('Яна');
    await page.getByRole('button',{name:'Изменить пользователя «Яна»',exact:true}).click();
    await expect(page.getByRole('dialog').getByLabel('Логин',{exact:true})).toHaveValue('yana');
    await expect(page.getByRole('dialog').getByLabel('Логин',{exact:true})).toHaveAttribute('readonly','');
  });
}
test('user removal identifies the account, handles a conflict and refreshes the list on success',async({page})=>{
  await fixture(page);
  const trigger=page.getByRole('button',{name:'Удалить пользователя «Яна»',exact:true});
  await trigger.click();
  const dialog=page.getByRole('alertdialog',{name:'Удалить пользователя?'});
  await expect(dialog).toContainText('Логин: yana');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  let calls=0;
  await page.route(`**/api/admin/users/${users[0].id}`,route=>{
    expect(route.request().method()).toBe('DELETE'); calls++;
    return route.fulfill(calls===1?{status:409,json:{error:{code:'user_in_use',message:'Сначала завершите активные сессии пользователя'}}}:{json:{ok:true}});
  });
  await trigger.click(); await dialog.getByRole('button',{name:'Удалить пользователя',exact:true}).click();
  await expect(dialog.getByRole('alert')).toHaveText('Сначала завершите активные сессии пользователя');
  await expect(page.locator('.user-record')).toHaveCount(3);
  await dialog.getByRole('button',{name:'Удалить пользователя',exact:true}).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('.user-record')).toHaveCount(2);
  await expect(page.locator('.notification-toast').filter({hasText:'Пользователь удалён'})).toContainText('Яна (@yana)');
  expect(calls).toBe(2);
});
