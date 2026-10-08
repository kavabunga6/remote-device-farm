import { test, expect } from '@playwright/test';
const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64);
for (const language of ['ru', 'en'] as const) for (const theme of ['light', 'dark'] as const) {
  test('image cleanup confirmation and aligned policies ' + language + ' ' + theme, async ({ page }) => {
    await page.addInitScript(language => localStorage.setItem('rdf.language', language), language); await page.emulateMedia({ colorScheme: theme });
    const ru = language === 'ru';
    let submitted: any = null;
    const items = [{ digest: A, tags: ['current'], package: 'system-images;android-36;default;x86_64', sizeBytes: 3 * 1024 ** 3, createdAt: '2026-01-01T00:00:00Z', children: [], known: true, uses: [{ kind: 'profile', id: 'profile', name: 'Android 16 · AOSP', image: 'registry/rdf-emulator@' + A }], blockers: [] }, { digest: B, tags: [], package: 'system-images;android-35;default;x86_64', sizeBytes: 3 * 1024 ** 3, createdAt: '2026-01-01T00:00:00Z', children: [], known: true, uses: [], blockers: ['session'] }];
    const policy = { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 };
    await page.route('**/api/admin/image-management/**', async route => {
      const url = new URL(route.request().url()), body = route.request().postDataJSON();
      if (url.pathname.endsWith('/registry')) return route.fulfill({ json: { supported: true, repository: 'registry/rdf-emulator', items, maintenance: false } });
      if (url.pathname.endsWith('/policy')) return route.fulfill({ json: { policy } });
      if (url.pathname.endsWith('/jobs')) { if (body) submitted = body; return route.fulfill({ json: body ? { id: 'job' } : { items: [] } }); }
      if (url.pathname.endsWith('/preview')) return route.fulfill({ json: { plan: { ...body, token: 'abc', items: [items[0]], blocked: false } } });
      return route.fulfill({ json: { hostId: 'h1', items: [] } });
    });
    await page.goto('/#/admin/images');
    await expect(page.getByRole('heading', { name: ru ? 'Образы' : 'Images', exact: true })).toBeVisible();
    const deletes = page.getByRole('button', { name: /^(Удалить образ|Delete image) system/ });
    await expect(deletes.nth(1)).toBeDisabled();
    await deletes.first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(ru ? 'Эти профили будут отключены автоматически.' : 'These profiles will be disabled automatically.')).toBeVisible();
    await dialog.getByRole('checkbox', { name: ru ? 'Также удалить связанные профили' : 'Also delete linked profiles' }).check();
    await dialog.getByRole('button', { name: ru ? 'Выполнить очистку' : 'Run cleanup', exact: true }).click();
    await expect.poll(() => submitted?.removeProfiles).toBe(true);
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: ru ? 'Политики хранения' : 'Retention policies', exact: true }).click();
    await page.locator('.image-policy-field input').first().waitFor(); await page.evaluate(() => document.fonts.ready);
    const groups = await page.locator('.image-policy-grid').evaluateAll(groups => groups.map(group => Array.from(group.querySelectorAll('input')).map(input => { const rect = input.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; })));
    for (const group of groups) if (group.length === 2) { expect(Math.abs(group[0].top - group[1].top)).toBeLessThanOrEqual(1); expect(Math.abs(group[0].bottom - group[1].bottom)).toBeLessThanOrEqual(1); }
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
  });
}


test('node cache cleanup submits only local image IDs for the selected node', async ({ page }) => {
  let submitted: any = null;
  const item = { id: B, tags: ['registry/rdf-emulator:old'], digests: ['registry/rdf-emulator@' + A], package: 'system-images;android-35;default;x86_64', sizeBytes: 1024 ** 3, firstSeenAt: '2026-01-01T00:00:00Z', lastUsedAt: null, uses: [], blockers: [] };
  await page.route('**/api/admin/image-management/**', async route => {
    const url = new URL(route.request().url()), body = route.request().postDataJSON();
    if (url.pathname.endsWith('/registry')) return route.fulfill({ json: { supported: true, repository: 'registry/rdf-emulator', items: [], maintenance: false } });
    if (url.pathname.endsWith('/policy')) return route.fulfill({ json: { policy: { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 } } });
    if (url.pathname.endsWith('/jobs')) { if (body) submitted = body; return route.fulfill({ json: body ? { id: 'cache-job' } : { items: [] } }); }
    if (url.pathname.endsWith('/preview')) return route.fulfill({ json: { plan: { ...body, token: 'cache-token', items: [item], blocked: false } } });
    return route.fulfill({ json: { items: [item] } });
  });
  await page.goto('/#/admin/images'); await page.getByRole('button', { name: 'Кэш узлов', exact: true }).click();
  const host = await page.locator('.image-node-field select').inputValue(); expect(host).not.toBe('');
  await page.getByRole('button', { name: 'Удалить образ ' + item.package, exact: true }).click();
  const dialog = page.getByRole('alertdialog'); await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Выполнить очистку', exact: true }).click();
  await expect.poll(() => submitted?.scope).toBe('cache'); expect(submitted.hostId).toBe(host); expect(submitted.ids).toEqual([B]); expect(submitted.token).toBe('cache-token'); expect(submitted.items).toBeUndefined(); expect(submitted.digests).toBeUndefined();
});

for (const [language, theme, width, scale] of [['ru', 'dark', 1920, 1], ['en', 'light', 1024, 1.25]] as const) {
  test('readable image variants, filters and desktop layout ' + language + ' ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(language => localStorage.setItem('rdf.language', language), language);
    await page.emulateMedia({ colorScheme: theme });
    const pkg = 'system-images;android-36.1;google_apis;x86_64';
    const variants = [
      { digest: A, package: pkg, tags: ['36.1-google_apis-x86_64'], sizeBytes: 3 * 1024 ** 3, createdAt: '2026-10-08T10:00:00Z', uses: [], blockers: [] },
      { digest: B, package: 'system-images;android-36;aosp_atd;x86_64', tags: [], sizeBytes: 1024 ** 3, uses: [], blockers: ['session'] },
    ];
    const baseline = { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 };
    let saved: any = null;
    await page.route('**/api/admin/image-management/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/registry')) return route.fulfill({ json: { supported: true, repository: 'registry.example.test/rdf-emulator', items: variants, maintenance: false } });
      if (path.endsWith('/policy')) { if (route.request().method() === 'PUT') saved = route.request().postDataJSON(); return route.fulfill({ json: { policy: { ...(saved ?? baseline), lastRunAt: new Date().toISOString() } } }); }
      if (path.endsWith('/jobs')) return route.fulfill({ json: { items: [] } });
      return route.fulfill({ json: { items: [] } });
    });
    await page.goto('/#/admin/images');
    await page.locator('.image-inventory-table').waitFor();
    await page.evaluate(scale => document.documentElement.style.fontSize = 16 * scale + 'px', scale);
    await page.evaluate(() => document.fonts.ready);
    const rows = page.locator('.image-inventory-table tbody tr');
    await expect(rows.first()).toContainText('Android 16 · Google APIs');
    await expect(rows.first()).toContainText('API 36.1');
    await expect(rows.nth(1)).toContainText('Android 16 · AOSP ATD');
    await expect(rows.first().locator('.image-details dl')).toBeHidden();
    await rows.first().locator('.image-details summary').click();
    await expect(rows.first().locator('.image-details dd').first()).toHaveText(pkg);
    await expect(rows.first().locator('.image-details')).toContainText(A);
    await rows.first().locator('.image-details summary').click();
    await page.locator('.image-search-field input').fill('Android 16'); await expect(rows).toHaveCount(2);
    await page.locator('.image-usage-field select').selectOption('protected'); await expect(rows).toHaveCount(1);
    await expect(rows.first().getByRole('button', { name: /^(Удалить образ|Delete image) / })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator('.image-controls').evaluate(group => Array.from(group.querySelectorAll('input,select')).map(control => { const r = control.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
    for (const b of bounds) expect(b.height).toBeCloseTo(40 * scale, 0);
    if (width > 1200) expect(bounds[0].top).toBe(bounds[1].top);
    await page.getByRole('button', { name: language === 'ru' ? 'Политики хранения' : 'Retention policies', exact: true }).click();
    const save = page.locator('.image-policy-save button'); await expect(save).toBeDisabled();
    await page.getByRole('switch').first().check(); await page.getByRole('switch').nth(1).check();
    await expect(save).toBeEnabled();
    const fields = await page.locator('.image-policy-grid').evaluateAll(groups => groups.map(group => Array.from(group.querySelectorAll('input')).map(input => { const b = input.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })));
    if (width > 1200) expect(Math.abs(fields[0][0].top - fields[1][0].top)).toBeLessThanOrEqual(1);
    await save.click(); await expect(save).toBeDisabled();
    expect(saved.registryEnabled).toBe(true); expect(saved.cacheEnabled).toBe(true); expect(saved.lastRunAt).toBeUndefined();
    await page.getByRole('button', { name: language === 'ru' ? 'История очистки' : 'Cleanup history', exact: true }).click();
    await expect(page.locator('.image-empty-state h3')).toHaveText(language === 'ru' ? 'Очисток пока нет' : 'No cleanup jobs yet');
    await page.getByRole('button', { name: language === 'ru' ? 'Настроить автоочистку' : 'Configure automatic cleanup', exact: true }).click();
    await expect(page.getByRole('switch').first()).toBeChecked();
  });
}

for (const language of ['ru', 'en'] as const) test('inventory summary, version filter, clipboard and selection survive filtering ' + language, async ({ page, context }) => {
  const ru = language === 'ru';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), language);
  const C = 'sha256:' + 'c'.repeat(64);
  let items = [
    { digest: A, package: 'system-images;android-35;default;x86_64', tags: [], sizeBytes: 3 * 1024 ** 3, uses: [], blockers: [] as string[] },
    { digest: B, package: 'system-images;android-36.1;google_apis;x86_64', tags: ['current'], sizeBytes: 2 * 1024 ** 3, uses: [{ kind: 'profile', id: 'phone', name: 'Android 16', image: B }], blockers: [] as string[] },
    { digest: C, package: 'system-images;android-36;aosp_atd;x86_64', tags: [], sizeBytes: 1024 ** 3, uses: [], blockers: ['session'] },
  ];
  const requests: string[] = [];
  await page.route('**/api/admin/image-management/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') requests.push(path);
    if (path.endsWith('/registry')) return route.fulfill({ json: { supported: true, repository: 'registry.example.test/rdf-emulator', items, maintenance: false } });
    if (path.endsWith('/policy')) return route.fulfill({ json: { policy: { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 } } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/#/admin/images');
  const summary = page.locator('.image-inventory-summary');
  await expect(summary.locator('.image-summary-item').first()).toContainText(ru ? '6 ГБ' : '6 GB');
  await summary.getByRole('button', { name: ru ? /^Неиспользуемые/ : /^Unused/ }).click();
  await expect(page.locator('.image-inventory-table tbody tr')).toHaveCount(1);
  await page.locator('.image-select-cell input').check();
  await expect(page.locator('.image-selected-size')).toHaveText(ru ? 'Размер слоёв: 3 ГБ' : 'Layer size: 3 GB');
  await page.locator('.image-usage-field select').selectOption('all');
  await page.locator('.image-version-field select').selectOption('36');
  const rows = page.locator('.image-inventory-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.image-hidden-selection')).toHaveText(ru ? 'Вне фильтра: 1' : 'Outside this filter: 1');
  await expect(rows.first()).toContainText('API 36.1');
  await expect(rows.nth(1).getByRole('checkbox')).toBeDisabled();
  await page.locator('.image-selection input').check();
  await expect(page.locator('.image-selected-size')).toHaveText(ru ? 'Размер слоёв: 5 ГБ' : 'Layer size: 5 GB');
  await expect(page.locator('.image-selection').getByRole('button', { name: ru ? 'Удалить выбранные (2)' : 'Delete selected (2)', exact: true })).toBeEnabled();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await rows.nth(1).getByRole('button', { name: ru ? 'Копировать идентификатор' : 'Copy identifier', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(C);
  await page.getByRole('button', { name: ru ? 'Скопировать адрес registry' : 'Copy registry address', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('registry.example.test/rdf-emulator');
  // Refresh protection even for a selected image hidden by the version filter.
  items = items.map(item => item.digest === A ? { ...item, blockers: ['queue'] } : item);
  await page.locator('.image-refresh').click();
  await expect(page.locator('.image-selected-size')).toHaveText(ru ? 'Размер слоёв: 2 ГБ' : 'Layer size: 2 GB');
  await expect(page.locator('.image-hidden-selection')).toHaveCount(0);
  await page.getByRole('button', { name: ru ? 'Снять выделение' : 'Clear selection', exact: true }).click();
  await expect(page.locator('.image-selected-size')).toHaveCount(0);
  expect(requests).toEqual([]);
  await page.locator('.image-policy-link').click();
  await expect(page.getByRole('switch').first()).not.toBeChecked();
});

test('registry maintenance reports work and prevents deletion until inventory refreshes', async ({ page }) => {
  let maintenance = true;
  const item = { digest: A, package: 'system-images;android-35;default;x86_64', tags: [], sizeBytes: 1024 ** 3, uses: [], blockers: [] };
  await page.route('**/api/admin/image-management/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/registry') ? { supported: true, repository: 'registry.example.test/rdf-emulator', maintenance, items: [item] } : path.endsWith('/policy') ? { policy: { registryEnabled: false, registryKeep: 3, registryDays: 30, cacheEnabled: false, cacheDays: 30, cacheMaxGb: 0, intervalHours: 24 } } : { items: [] } });
  });
  await page.goto('/#/admin/images');
  await expect(page.locator('.image-process')).toBeVisible();
  await expect(page.locator('.image-select-cell input')).toBeDisabled();
  await expect(page.locator('.image-action-cell button')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Освободить место', exact: true })).toBeDisabled();
  await expect(page.locator('.image-identifier-copy')).toBeEnabled();
  maintenance = false;
  await page.locator('.image-refresh').click();
  await expect(page.locator('.image-process')).toHaveCount(0);
  await expect(page.locator('.image-action-cell button')).toBeEnabled();
});
