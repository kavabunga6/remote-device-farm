import { expect, test } from '@playwright/test';

test('profile controls lock while saving and unlock with retained values after a failure', async ({ page }) => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/admin/profiles/*', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      await gate;
      await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Service unavailable' } } });
    } else await route.fulfill({ json: { profile: writes.at(-1) } });
  });
  await page.goto('/#/admin/profiles');
  await page.locator('.admin-profile-row .card-primary-action').first().click();
  const dialog = page.getByRole('dialog', { name: 'Изменить профиль' });
  const name = dialog.getByLabel('Название', { exact: true });
  await name.fill('Verified profile');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  try {
    await expect.poll(() => writes.length).toBe(1);
    await expect(dialog.locator('form')).toHaveAttribute('aria-busy', 'true');
    await expect(dialog.locator('fieldset :is(input, select, textarea):enabled')).toHaveCount(0);
    await expect(name).toBeDisabled();
    await expect(dialog.locator('footer input[type=checkbox]')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
  } finally { finish(); }
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue('Verified profile');
  await name.fill('Verified profile retry');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes.map(write => write.name)).toEqual(['Verified profile', 'Verified profile retry']);
});

test('failed profile export shows feedback and allows a single download on retry', async ({ page }) => {
  let writes = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const manifest = { version: 1, profiles: [] };
  await page.route('**/api/admin/profiles/export', async route => {
    writes++;
    if (writes === 1) {
      await gate;
      await route.fulfill({ status: 500, json: { error: { code: 'export_failed', message: 'Service unavailable' } } });
    } else await route.fulfill({ json: manifest });
  });
  await page.goto('/#/admin/profiles');
  await page.locator('.admin-profile-tools > summary').click();
  const exportButton = page.getByRole('button', { name: 'Экспорт', exact: true });
  await exportButton.click();
  try {
    await expect.poll(() => writes).toBe(1);
    await expect(page.getByRole('button', { name: 'Экспортируем…', exact: true })).toBeDisabled();
  } finally { finish(); }
  await expect(page.locator('.notification-title')).toHaveText('Не удалось экспортировать профили');
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('device-farm-profiles.json');
  expect(writes).toBe(2);
  const contents = await download.createReadStream();
  let data = '';
  for await (const chunk of contents!) data += chunk.toString();
  expect(JSON.parse(data)).toEqual(manifest);
});

test('image catalog is reachable directly from image administration', async ({ page }) => {
  await page.goto('/#/admin/images');
  const trigger = page.getByRole('button', { name: 'Каталог образов', exact: true });
  await trigger.click();
  await expect(page.locator('.emulator-catalog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
