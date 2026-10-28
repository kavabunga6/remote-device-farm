import { expect, test } from '@playwright/test';

for (const width of [1366, 390]) test(`catalog profile keeps 6 GB requirement and explains a 4 GB slot at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const profile = { id: 'catalog-api33', name: 'Android 13 · Google APIs', androidVersion: '13', apiLevel: 33,
    abi: 'x86_64', image: 'registry.example.test/android:api33', imageFlavor: 'google_apis',
    cpu: 4, memoryMb: 6144, guestMemoryMb: 4096, guestCores: 2, diskGb: 16, enabled: true };
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [profile] } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    for (const host of body.hosts) Object.assign(host, { status: 'online', disabled: false, lastSeenAt: new Date().toISOString(), slotCpu: 4, slotMemoryMb: 4096, slots: 2, usedSlots: 0 });
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
  const readiness = modal.getByRole('region', { name: 'Проверка запуска', exact: true });
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText('требуется 4 CPU и 6 ГБ памяти; лимит слота — 4 CPU и 4 ГБ');
  await expect(readiness.getByRole('link', { name: /Настроить узел/ })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await expect(modal.locator('.create-summary-resources')).toContainText('2 яд. · 4 ГБ');
  await expect(modal.locator('.create-summary-resources')).toContainText('4 CPU · 6 ГБ');
  await modal.locator('#create-tab-settings').click();
  await expect(modal.getByLabel('Память Android, МБ', { exact: true })).toHaveValue('4096');
  await expect(modal.getByLabel('Лимит памяти на узле, МБ', { exact: true })).toHaveValue('6144');
  // Lowering the container limit explicitly still cannot silently lower Android memory.
  await modal.getByLabel('Лимит памяти на узле, МБ', { exact: true }).fill('4096');
  await expect(modal.getByLabel('Память Android, МБ', { exact: true })).toHaveValue('4096');
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await expect(modal.locator('.create-launch-status')).toContainText('минимум 1024 МБ');
});
