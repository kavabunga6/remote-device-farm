import { expect, test } from '@playwright/test';

test('users can be searched and filtered by company and job title', async ({ page }) => {
  await page.goto('/#/admin/users');
  const rows = page.locator('.user-record');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.page-heading .count-badge')).toHaveCount(0);
  await page.getByLabel('Найти пользователя').fill('иван');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.page-heading .count-badge')).toHaveCount(0);
  await expect(rows.first()).toContainText('Иван');
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByLabel('Компания').selectOption('Тестовая компания');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Должность').selectOption('Android-разработчик');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Найти пользователя').fill('нет такого');
  await expect(page.getByText('Никого не найдено')).toBeVisible();
});

test('nodes can be searched by name and address', async ({ page }) => {
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    const first = body.hosts[0];
    body.hosts = [first, { ...first, id: 'h2', name: 'lab-gpu', agentName: 'lab-gpu', displayName: null, metrics: { ...first.metrics, hostIp: '10.0.0.77' } }];
    await route.fulfill({ json: body });
  });
  await page.goto('/#/admin/nodes');
  const cards = page.locator('.node-overview');
  await expect(cards).toHaveCount(2);
  await page.getByLabel('Найти узел').fill('10.0.0.7');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('lab-gpu');
  await page.getByLabel('Найти узел').fill('worker');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('worker-01');
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(cards).toHaveCount(2);
});
