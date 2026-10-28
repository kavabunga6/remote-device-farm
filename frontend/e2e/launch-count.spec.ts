import { openLaunchSection } from './launch-controls';
import { expect, test } from '@playwright/test';

test('several identical devices start from one dialog and a session card offers "one more like this"', async ({ page }) => {
  const posts: unknown[] = [];
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postDataJSON());
    const ids = ['aaaaaaaa-0000-4000-8000-00000000000' + posts.length];
    await route.fulfill({ status: 202, json: { session: { id: ids[0], state: 'starting', profileId: 'a11-gpu', hostId: 'h1', hostName: 'worker-01', createdAt: new Date().toISOString() } } });
  });
  await page.goto('/');
  await expect(page.locator('.session-card').first()).toBeVisible();
  await page.locator('.session-card').first().getByRole('button', { name: 'Ещё такой же' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая сессия' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#create-tab-settings').click();
  await openLaunchSection(dialog, 'connection');
  await dialog.getByLabel('Количество устройств').fill('3');
  await dialog.getByRole('button', { name: 'Запустить ×3' }).click();
  await expect.poll(() => posts.length).toBe(3);
  await expect(page.locator('.toast, .notification-toast').filter({ hasText: 'Запущено устройств: 3' })).toBeVisible();
});
