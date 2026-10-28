import { expect, test } from '@playwright/test';

const manifest = { version: 1, profiles: [{ id: 'qa-14', name: 'QA 14', image: { repository: 'registry.example.com/emu/a14', tag: '1' }, container: { env: { TOKEN: 'secret' } } }] };

test('a manifest is checked first, applied only when clean, and creates disabled profiles', async ({ page }) => {
  const calls: Array<{ apply: boolean; update: boolean }> = [];
  await page.route('**/api/admin/profiles/import', async route => {
    const body = route.request().postDataJSON();
    calls.push({ apply: body.apply, update: body.update });
    const result = { id: 'qa-14', name: 'QA 14', action: 'create', issues: [], warnings: ['The image is not pinned by digest; a tag can be replaced upstream.'] };
    await route.fulfill({ json: { applied: body.apply === true, issues: [], results: [result] } });
  });
  await page.goto('/#/admin/profiles');
  await page.locator('.admin-profile-tools > summary').click();
  await page.getByRole('button', { name: 'Импорт JSON' }).click();
  const dialog = page.getByRole('dialog', { name: 'Импорт профилей из JSON' });
  await expect(dialog).toContainText('выключенными');
  await expect(dialog.getByRole('button', { name: 'Применить' })).toBeDisabled();
  await dialog.getByLabel('или вставьте JSON').fill(JSON.stringify(manifest));
  await dialog.getByRole('button', { name: 'Проверить' }).click();
  await expect(dialog).toContainText('Будет создан');
  await expect(dialog).toContainText('Образ не закреплён по digest');
  expect(calls).toEqual([{ apply: false, update: false }]);
  await dialog.getByRole('button', { name: 'Применить' }).click();
  await expect(dialog).toContainText('Профили созданы выключенными');
  expect(calls.at(-1)).toEqual({ apply: true, update: false });
});

test('problems block applying and are shown with the path of the field', async ({ page }) => {
  await page.route('**/api/admin/profiles/import', route => route.fulfill({ json: { applied: false, issues: [], results: [
    { id: 'bad', name: 'Bad', action: 'invalid', issues: [{ path: '$.profiles[0].container.privileged', message: 'unknown field' }], warnings: [] }] } }));
  await page.goto('/#/admin/profiles');
  await page.locator('.admin-profile-tools > summary').click();
  await page.getByRole('button', { name: 'Импорт JSON' }).click();
  const dialog = page.getByRole('dialog', { name: 'Импорт профилей из JSON' });
  await dialog.getByLabel('или вставьте JSON').fill('{"version":1,"profiles":[{}]}');
  await dialog.getByRole('button', { name: 'Проверить' }).click();
  await expect(dialog).toContainText('$.profiles[0].container.privileged');
  await expect(dialog.getByRole('button', { name: 'Применить' })).toBeDisabled();
  await dialog.getByLabel('или вставьте JSON').fill('not json');
  await dialog.getByRole('button', { name: 'Проверить' }).click();
  await expect(dialog).toContainText('не корректный JSON');
});
