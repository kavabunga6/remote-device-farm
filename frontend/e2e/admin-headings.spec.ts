import { expect, test } from '@playwright/test';

const sections = [
  ['sessions', 'Все сессии', 'Все сессии:'],
  ['nodes', 'Узлы', 'Машины, на которых запускаются'],
  ['profiles', 'Профили устройств', 'Docker-образы эмуляторов'],
  ['users', 'Пользователи', 'Учётные записи, роли'],
  ['ops', 'Нагрузка', 'Занятость слотов'],
  ['journal', 'Журнал', 'Аренды, действия'],
] as const;

for (const [id, title, description] of sections) {
  test(`admin ${id} header shows its own title and description`, async ({ page }) => {
    await page.goto('/#/admin/' + id);
    const heading = page.locator('.page-heading');
    await expect(heading.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(heading).toContainText(description);
    await expect(heading.getByRole('heading', { level: 1 })).not.toHaveText('Администрирование');
  });
}

test('the retired agents page opens nodes, where nodes can be connected', async ({ page }) => {
  await page.goto('/#/admin/agents');
  await expect(page.locator('.page-heading').getByRole('heading', { level: 1 })).toHaveText('Узлы');
  await page.getByRole('button', { name: 'Подключить узел' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a running session can be recreated clean with the same settings', async ({ page }) => {
  const calls: string[] = [];
  const launchOptions = { cpu: 3, memoryMb: 5120, guestCores: 2, guestMemoryMb: null,
    diskGb: 12, sdCardMb: 0, emulatorParams: '-no-boot-anim', privileged: false };
  let createdSettings: Record<string, unknown> | undefined;
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: body.session ? { ...body, session: { ...body.session, gpuMode: 'nvidia', launchOptions } } : body });
    }
    if (route.request().method() !== 'DELETE') return route.continue();
    calls.push('release'); await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    createdSettings = route.request().postDataJSON();
    calls.push('create:' + JSON.stringify(createdSettings!.profileId));
    await route.fulfill({ status: 202, json: { session: { id: 'dddddddd-0000-4000-8000-000000000001', state: 'starting', profileId: 'a11-gpu', hostId: 'h1', createdAt: new Date().toISOString() } } });
  });
  await page.goto('/');
  await page.locator('.session-card').first().locator('h3, strong').first().click();
  await page.getByRole('button', { name: 'Пересоздать' }).click();
  await expect(page.getByText('Данные удалятся. Пересоздать?')).toBeVisible();
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: 'Да', exact: true }).click();
  await expect(page).toHaveURL(/#\/session\/dddddddd-0000-4000-8000-000000000001$/);
  expect(calls).toEqual(['release', 'create:"a11-gpu"']);
  expect(createdSettings?.gpuMode).toBe('nvidia');
  expect(createdSettings?.launchOptions).toEqual(launchOptions);
});
