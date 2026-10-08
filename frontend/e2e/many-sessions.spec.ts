import { expect, test } from '@playwright/test';

test('many sessions remain accessible and can all be released after one confirmation', async ({ page }) => {
  const released: string[] = [];
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    id: `cbd55091-aaaa-bbbb-cccc-00000000000${i}`,
    ownerId: 'u1', ownerName: 'QA', hostId: 'h1', hostName: 'worker-01',
    profileId: 'a11-gpu', profileName: 'Android 11', state: 'running',
    createdAt: new Date().toISOString(), expiresAt: null, idleExpiresAt: null,
  }));
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { sessions: sessions.filter(session => !released.some(url => url.endsWith('/' + session.id))) } });
  });
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    released.push(route.request().url());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect(page.locator('.page-overview .session-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Завершить все (5)' }).click();
  expect(released).toHaveLength(0);
  await page.getByRole('button', { name: 'Да, завершить все' }).click();
  await expect.poll(() => released.length).toBe(5);
  await expect(page.locator('.page-overview .session-card:not(.session-create-card)')).toHaveCount(0);
});
