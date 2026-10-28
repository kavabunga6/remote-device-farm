import { openLaunchSection } from './launch-controls';
import { expect, test } from '@playwright/test';

for (const language of ['ru', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`ADB key downloads keep keyboard focus and require both files in ${language} / ${theme}`, async ({ page }) => {
    const copy = language === 'ru'
      ? { title: 'Сохраните ключи ADB', private: 'Скачать adbkey', public: 'Скачать adbkey.pub', done: 'Готово', close: 'Закрыть без сохранения', confirm: 'Закрыть без сохранения?', cancel: 'Отмена', remaining: 'Осталось скачать приватный файл adbkey.', complete: 'Оба файла скачаны. Можно завершить настройку.', replace: 'Заменить ключ', notice: 'Оба файла скачаны.', create: 'Создать и скачать', custom: 'Использовать другую папку' }
      : { title: 'Save your ADB keys', private: 'Download adbkey', public: 'Download adbkey.pub', done: 'Done', close: 'Close without saving', confirm: 'Close without saving?', cancel: 'Cancel', remaining: 'Download the private adbkey file to continue.', complete: 'Both files downloaded. You can finish setup.', replace: 'Replace key', notice: 'Both files downloaded.', create: 'Create and download', custom: 'Use another folder' };
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.emulateMedia({ colorScheme: theme });
    await page.route('**/api/me/adb-key', route => route.fulfill({ json: route.request().method() === 'GET'
      ? { key: null }
      : { fingerprint: 'SHA256:mock-key', createdAt: new Date().toISOString(), privateKey: 'mock-private-key', publicKey: 'mock-public-key' } }));
    await page.goto('/#/account/keys');
    await page.getByRole('button', { name: copy.create, exact: true }).click();

    const dialog = page.getByRole('dialog', { name: copy.title });
    const privateDownload = dialog.getByRole('button', { name: copy.private, exact: true });
    const publicDownload = dialog.getByRole('button', { name: copy.public, exact: true });
    const done = dialog.getByRole('button', { name: copy.done, exact: true });
    await expect(privateDownload).toBeFocused();
    await expect(done).toBeDisabled();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: copy.close, exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(privateDownload).toBeFocused();
    const customFolder = dialog.locator('details');
    await expect(customFolder).not.toHaveAttribute('open', '');
    await customFolder.locator('summary').click();
    await expect(customFolder.getByText(/ADB_VENDOR_KEYS/)).toBeVisible();
    await customFolder.locator('summary').click();

    await page.keyboard.press('Escape');
    await expect(dialog.getByText(copy.confirm, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: copy.cancel, exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: copy.cancel, exact: true }).click();
    await expect(dialog).toBeVisible();

    const publicFile = page.waitForEvent('download');
    await publicDownload.click();
    expect((await publicFile).suggestedFilename()).toBe('adbkey.pub');
    await expect(done).toBeDisabled();
    await expect(dialog.getByRole('status')).toHaveText(copy.remaining);
    const privateFile = page.waitForEvent('download');
    await privateDownload.click();
    expect((await privateFile).suggestedFilename()).toBe('adbkey');
    await expect(done).toBeEnabled();
    await expect(dialog.getByRole('status')).toHaveText(copy.complete);
    await expect(dialog.locator('.account-key-file-download.downloaded')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: copy.close, exact: true })).toHaveCount(0);
    await done.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy.replace, exact: true })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: copy.notice })).toBeVisible();
  });
}

for (const [language, theme] of [['ru', 'light'], ['en', 'dark']] as const) {
  test(`ADB key rename supports cancellation, retry and the launch picker in ${language}`, async ({ page }) => {
    const id = '11111111-1111-4111-8111-111111111111';
    let key = { id, name: 'Developer laptop', fingerprint: 'a'.repeat(64), createdAt: '2026-10-01T12:00:00Z' };
    const original = { ...key };
    const requests: Record<string, unknown>[] = [];
    let allowSave: (() => void) | undefined;
    const saveGate = new Promise<void>(resolve => { allowSave = resolve; });
    const copy = language === 'ru'
      ? { rename: 'Переименовать ключ «Developer laptop»', name: 'Название', save: 'Сохранить название ключа', cancel: 'Отмена', invalid: 'Название должно содержать от 1 до 80 символов', saved: 'Название ключа сохранено', newSession: 'Новая сессия', adb: 'Ключ ADB' }
      : { rename: 'Rename key “Developer laptop”', name: 'Name', save: 'Save key name', cancel: 'Cancel', invalid: 'Name must be 1 to 80 characters', saved: 'Key name saved', newSession: 'New session', adb: 'ADB key' };
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.route(/\/api\/me\/preferences(?:\?|$)/, route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1, defaultAdbKeyId: id } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/me/adb-public-keys', route => route.fulfill({ json: { keys: [key] } }));
    await page.route('**/api/me/adb-public-keys/' + id, async route => {
      expect(route.request().method()).toBe('PATCH');
      const body = route.request().postDataJSON();
      requests.push(body);
      if (requests.length === 1) return route.fulfill({ status: 400, json: { error: { code: 'invalid_adb_key_name', message: 'Name must be 1 to 80 characters' } } });
      await saveGate;
      key = { ...key, name: body.name };
      await route.fulfill({ json: { key } });
    });
    await page.goto('/#/account/keys');
    const row = page.locator('.account-key-row');
    const edit = row.getByRole('button', { name: copy.rename, exact: true });
    await edit.click();
    const form = row.getByRole('form', { name: copy.rename, exact: true });
    const name = form.getByRole('textbox', { name: copy.name, exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(original.name);
    await name.fill('Unsaved change');
    await name.press('Escape');
    await expect(edit).toBeFocused();
    expect(requests).toHaveLength(0);
    await edit.click();
    await name.fill('   ');
    await expect(form.getByRole('button', { name: copy.save })).toBeDisabled();
    await name.fill('New laptop');
    await form.getByRole('button', { name: copy.save }).click();
    await expect(form.getByRole('alert')).toHaveText(copy.invalid);
    await expect(name).toHaveValue('New laptop');
    await name.fill('  Personal laptop  ');
    await form.getByRole('button', { name: copy.save }).click();
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await expect(form.getByRole('button', { name: copy.save })).toBeDisabled();
    await expect(form.getByRole('button', { name: copy.cancel })).toBeDisabled();
    allowSave!();
    await expect(form).toHaveCount(0);
    await expect(row.locator('strong')).toContainText('Personal laptop');
    await expect(page.getByRole('status').filter({ hasText: copy.saved })).toBeVisible();
    await expect(row.locator('.account-default-tag')).toBeVisible();
    expect(key).toEqual({ ...original, name: 'Personal laptop' });
    expect(requests).toEqual([{ name: 'New laptop' }, { name: 'Personal laptop' }]);
    await page.reload();
    await expect(row.locator('strong')).toContainText('Personal laptop');
    await page.goto('/#/overview');
    await page.getByRole('button', { name: copy.newSession, exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('#create-tab-settings').click();
    await openLaunchSection(modal, 'connection');
    const picker = modal.getByRole('combobox', { name: copy.adb, exact: true });
    await expect(picker).toHaveValue(id);
    await expect(picker.locator(`option[value="${id}"]`)).toHaveText('Personal laptop');
  });
}

for (const [language, theme] of [['ru', 'light'], ['en', 'dark']] as const) {
  test(`Uploaded and generated ADB keys have distinct states in ${language}`, async ({ page }) => {
    const id = '22222222-2222-4222-8222-222222222222';
    let keys = [{ id, name: 'Rj', fingerprint: 'b'.repeat(64), createdAt: '2026-10-02T17:51:00Z' }];
    let generated: { fingerprint: string; createdAt: string } | null = null;
    let defaultId: string | null = id;
    const copy = language === 'ru'
      ? { files: 'Ключи из файла', create: 'Нужен новый ключ?', absent: 'Не создан', personal: 'Личный ключ ADB', generated: 'Созданный ключ ADB', empty: 'Ключи из файла пока не добавлены', default: 'Основной', add: 'Добавить ключ', name: 'Название', cancel: 'Отмена', newSession: 'Новая сессия', adb: 'Ключ ADB' }
      : { files: 'Keys from a file', create: 'Need a new key?', absent: 'Not created', personal: 'Personal ADB key', generated: 'Generated ADB key', empty: 'No keys added from a file yet', default: 'Default', add: 'Add key', name: 'Name', cancel: 'Cancel', newSession: 'New session', adb: 'ADB key' };
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.route(/\/api\/me\/preferences(?:\?|$)/, route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1, defaultAdbKeyId: defaultId } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/me/adb-key', route => route.fulfill({ json: { key: generated } }));
    await page.route('**/api/me/adb-public-keys', route => route.fulfill({ json: { keys } }));
    await page.goto('/#/account/keys');
    const row = page.locator('.account-key-row');
    await expect(row.locator('strong')).toContainText('Rj');
    await expect(row.locator('.account-default-tag')).toHaveText(copy.default);
    await expect(page.getByRole('heading', { name: copy.files, exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: copy.create })).toBeVisible();
    await expect(page.getByText(copy.absent, { exact: true })).toHaveCount(0);
    await expect(page.getByText(copy.personal, { exact: true })).toHaveCount(0);
    await expect(page.locator('.account-farm-card')).toHaveCount(0);
    expect(await row.evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('.account-key-create')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.locator('.account-heading-actions').getByRole('button', { name: copy.add }).click();
    await expect(page.locator('#adb-upload-form').getByRole('textbox', { name: copy.name })).toBeFocused();
    await page.locator('.account-heading-actions').getByRole('button', { name: copy.cancel }).click();
    await page.goto('/#/overview');
    await page.getByRole('button', { name: copy.newSession, exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('#create-tab-settings').click();
    await openLaunchSection(modal, 'connection');
    await expect(modal.getByRole('combobox', { name: copy.adb, exact: true })).toHaveValue(id);
    await modal.getByRole('button', { name: copy.cancel, exact: true }).click();

    keys = [];
    generated = { fingerprint: 'SHA256:generated', createdAt: '2026-10-03T12:00:00Z' };
    defaultId = null;
    await page.goto('/#/account/keys');
    await expect(page.getByText(copy.empty, { exact: true })).toBeVisible();
    const createdKey = page.getByRole('region', { name: copy.generated });
    await expect(createdKey).toBeVisible();
    await expect(createdKey.locator('.account-default-tag')).toHaveText(copy.default);
    await expect(page.getByRole('region', { name: copy.create })).toHaveCount(0);
    await page.goto('/#/overview');
    await page.getByRole('button', { name: copy.newSession, exact: true }).click();
    await modal.locator('#create-tab-settings').click();
    await openLaunchSection(modal, 'connection');
    const picker = modal.getByRole('combobox', { name: copy.adb, exact: true });
    await expect(picker).toHaveValue('');
    await expect(picker.locator('option[value=""]')).toHaveText(copy.generated);
  });
}
