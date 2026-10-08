import { expect, test } from '@playwright/test';

test('regular users see sessions without infrastructure statistics or a node picker in the launch dialog', async ({ page }) => {
  await page.route('**/api/me', async route => { const body = await (await route.fetch()).json(); body.user.role = 'user'; await route.fulfill({ json: body }); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeVisible();
  await expect(page.getByText('Свободных слотов', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Узлов в сети')).toHaveCount(0);
  await expect(page.locator('.overview-hosts')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Администрирование', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar a[href^="#/admin/"]')).toHaveCount(0);
  await page.goto('/#/hosts');
  await expect(page.locator('.hosts-page')).toHaveCount(0);
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая сессия' }).first().click();
  await page.locator('.create-settings > summary').click();
  await expect(page.getByLabel('Узел запуска')).toHaveCount(0);
});
