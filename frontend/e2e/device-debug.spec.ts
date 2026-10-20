import { expect, test } from '@playwright/test';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const variant of [
  { language: 'ru', theme: 'light', scale: 1, width: 1440, layout: 'tools' },
  { language: 'en', theme: 'dark', scale: 1.5, width: 1440, layout: 'tools' },
  { language: 'ru', theme: 'dark', scale: 1, width: 768, layout: 'tools' },
  { language: 'en', theme: 'light', scale: 1, width: 1920, layout: 'split' },
]) test('traffic and WebView tools ' + JSON.stringify(variant), async ({ page }, info) => {
  let recording = false, updated = false, extra = false, cleared = false;
  const operations: string[] = [];
  const rows = () => cleared ? [] : Array.from({ length: extra ? 41 : 40 }, (_, n) => ({
    id: n + 1, method: n === 2 ? 'CONNECT' : n === 3 ? 'POST' : 'GET',
    url: n === 2 ? 'https://secure.example.test:443' : n === 1 ? 'http://assets.example.test/images/icon.png' : 'http://api.example.test/api/v1/items/' + (n + 1) + '?token=%5Bredacted%5D',
    startedAt: 1792492200 + n, status: n === 2 ? null : n === 3 ? 503 : 200,
    durationMs: n === 2 ? null : n === 0 && updated ? 1850 : 42 + n, bytes: 256 * (n + 1),
    requestHeaders: n === 2 ? [] : [{ name: 'content-type', value: 'application/vnd.sample+json' }],
    responseHeaders: n === 2 ? [] : [{ name: 'content-type', value: 'application/json' }, { name: 'content-length', value: '256' }],
  }));
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), variant.language);
  await page.setViewportSize({ width: variant.width, height: 1000 });
  if (variant.layout === 'split') await page.addInitScript(() => localStorage.setItem('rdf-console-width', '460'));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + id + '/network-inspector', async route => {
    if (route.request().method() === 'POST') {
      const p = route.request().postDataJSON(); operations.push(p.op);
      if (p.op === 'start') recording = true;
      if (p.op === 'stop') recording = false;
      if (p.op === 'clear') cleared = true;
    }
    await route.fulfill({ json: { available: true, recording, proxyActive: recording, pcapBytes: 0, entries: rows() } });
  });
  await page.route('**/api/sessions/' + id + '/network-inspector/har', route => route.fulfill({ headers: { 'content-disposition': 'attachment; filename="session.har"' }, json: { log: { version: '1.2', entries: [] } } }));
  await page.route('**/api/sessions/' + id + '/webviews', async route => {
    const op = route.request().method() === 'GET' ? 'list' : route.request().postDataJSON().op;
    await route.fulfill({ json: op === 'list' ? { pages: [{ target: 'webview_devtools_remote_1/page', title: 'Example checkout page', url: 'https://example.test/checkout' }] } : { result: { result: { value: op === 'document' ? '<html><body>Example checkout</body></html>' : 2 } } } });
  });
  await page.goto('/#/session/' + id);
  const layout = page.getByRole('group', { name: /Компоновка сессии|Session layout/ });
  await layout.getByRole('button', { name: variant.layout === 'tools' ? /^(Инструменты|Tools)$/ : /^(Рядом|Side by side)$/ }).click();
  await page.locator('#tool-tab-traffic').click();
  const traffic = page.locator('#tool-panel-traffic');
  const list = traffic.locator('.traffic-list');
  const details = traffic.locator('.traffic-detail');
  const search = traffic.getByRole('searchbox');
  await expect(traffic.locator('tbody tr')).toHaveCount(40);
  await traffic.getByRole('button', { name: /Начать запись|Start capture/ }).click();
  await expect(traffic.locator('footer [data-recording]')).toHaveAttribute('data-recording', 'true');
  await expect(traffic.getByRole('button', { name: /Очистить список|Clear list/ })).toBeDisabled();
  await traffic.getByRole('button', { name: /Остановить запись|Stop capture/ }).click();
  await expect(traffic.locator('footer [data-recording]')).toHaveAttribute('data-recording', 'false');
  await traffic.locator('[data-entry-id="1"]').click();
  await expect(traffic.locator('tr[data-selected=true]')).toHaveCount(1);
  await details.getByRole('tab', { name: /^(Ответ|Response)$/ }).click();
  await expect(details.locator('.traffic-headers')).toContainText('application/json');
  await expect(details.locator('.traffic-headers')).not.toContainText('application/vnd.sample');
  await details.getByRole('tab', { name: /^(Запрос|Request)$/ }).click();
  await expect(details.locator('.traffic-headers')).toContainText('application/vnd.sample+json');
  await expect(details.locator('.traffic-headers')).not.toContainText('content-length');
  await details.getByRole('tab', { name: /^(Обзор|Overview)$/ }).click();
  updated = true;
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(details.locator('.traffic-properties')).toContainText(/1.850/);
  // A new snapshot updates the selected entry without moving the list.
  await list.evaluate(el => { el.scrollTop = 180; });
  const scroll = await list.evaluate(el => el.scrollTop);
  await traffic.getByRole('button', { name: /Заморозить обновление|Freeze list/ }).click();
  extra = true;
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(traffic.locator('tbody tr')).toHaveCount(40);
  expect(await list.evaluate(el => el.scrollTop)).toBe(scroll);
  await traffic.getByRole('button', { name: /Возобновить обновление|Resume list/ }).click();
  await expect(traffic.locator('tbody tr')).toHaveCount(41);
  expect(await list.evaluate(el => el.scrollTop)).toBe(scroll);
  await list.evaluate(el => { el.scrollTop = 0; });
  await traffic.locator('[data-entry-id="1"]').press('ArrowDown');
  await expect(traffic.locator('[data-entry-id="2"]')).toBeFocused();
  await expect(traffic.locator('[data-entry-id="2"]')).toHaveAttribute('aria-pressed', 'true');
  const headings = traffic.locator('.traffic-sequence thead');
  await headings.getByRole('button', { name: /Sort by: Time|Сортировать по: Время/ }).click();
  await headings.getByRole('button', { name: /Sort by: Time|Сортировать по: Время/ }).click();
  await expect(traffic.locator('tbody .traffic-request').first()).toHaveAttribute('data-entry-id', '1');
  await expect(traffic.locator('[data-entry-id="2"]')).toHaveAttribute('aria-pressed', 'true');
  await headings.getByRole('button', { name: /Sort by: Started|Сортировать по: Начало/ }).click();
  await search.fill('POST 503');
  await expect(traffic.locator('tbody tr')).toHaveCount(1);
  await expect(traffic.locator('tbody tr')).toContainText('503');
  await search.fill('');
  await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('tunnels');
  await expect(traffic.locator('tbody tr')).toHaveCount(1);
  await traffic.locator('[data-entry-id="3"]').click();
  await expect(details).toContainText(/Зашифрованный CONNECT|Encrypted CONNECT/);
  await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('all');
  await search.fill('nothing-matches');
  await expect(traffic).toContainText(/Нет запросов, подходящих|No requests match/);
  await traffic.getByRole('button', { name: /Сбросить фильтры|Reset filters/ }).click();
  await expect(traffic.locator('tbody tr')).toHaveCount(41);
  await traffic.locator('[data-entry-id="4"]').click();
  await page.evaluate(() => document.fonts.ready);
  // Comparable controls align within each logical row in both themes and at 150% text.
  const bounds = await traffic.locator('.traffic-toolbar .traffic-control, .traffic-filterbar .traffic-control, .traffic-filterbar input, .traffic-filterbar select').evaluateAll(items =>
    items.map(item => { const b = item.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }));
  for (let n = 0; n < bounds.length; n++) for (let k = n + 1; k < bounds.length; k++) if (Math.abs(bounds[n]!.top - bounds[k]!.top) < 5) {
    expect(Math.abs(bounds[n]!.top - bounds[k]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds[n]!.bottom - bounds[k]!.bottom)).toBeLessThanOrEqual(1);
  }
  const box = await traffic.boundingBox();
  const tool = await traffic.locator('..').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(tool!.y + tool!.height + 1);
  expect(await traffic.locator('.traffic-detail').evaluate(el => el.clientHeight)).toBeGreaterThan(100);
  const selectMetrics = await traffic.locator('select').evaluate(el => { const s = getComputedStyle(el); return { top: s.paddingTop, bottom: s.paddingBottom }; });
  expect(selectMetrics).toEqual({ top: '0px', bottom: '0px' });
  expect(await traffic.locator('tbody td:first-child').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(160);
  if (variant.layout === 'split') expect(box!.width).toBeLessThan(500);
  await traffic.screenshot({ path: info.outputPath('traffic.png') });
  const divider = traffic.getByRole('separator');
  const direction = await divider.getAttribute('aria-orientation') === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  await divider.press(direction);
  await expect(divider).toHaveAttribute('aria-valuenow', '53');
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '48');
  await traffic.getByRole('button', { name: /^(По хостам|Structure)$/ }).click();
  await search.fill('api.example.test GET items/1');
  await expect(traffic.locator('.traffic-tree-node').first()).toContainText('http://api.example.test');
  await traffic.locator('[data-entry-id="1"]').click();
  await traffic.screenshot({ path: info.outputPath('traffic-structure.png') });
  const download = page.waitForEvent('download'); await traffic.getByRole('link', { name: 'HAR' }).click();
  expect((await download).suggestedFilename()).toBe('session.har');
  await search.fill('');
  await traffic.getByRole('button', { name: /Параметры и ограничения|Capture settings/ }).click();
  await expect(traffic.getByRole('checkbox')).toBeVisible();
  await expect(traffic.locator('#traffic-options')).toContainText(/учётные данные|credentials/);
  await traffic.getByRole('button', { name: /Параметры и ограничения|Capture settings/ }).click();
  await traffic.getByRole('button', { name: /Очистить список|Clear list/ }).click();
  await expect(traffic.locator('.traffic-tree-node')).toHaveCount(0);
  await expect(details).toContainText(/Выберите запрос|Select a request/);
  await page.locator('#tool-tab-webviews').click();
  const web = page.locator('#tool-panel-webviews');
  await web.getByRole('button', { name: /Прочитать HTML|Read HTML/ }).click();
  await expect(web.locator('pre')).toContainText('<html>');
  await web.locator('textarea').fill('1 + 1');
  await web.getByRole('button', { name: /^(Выполнить|Run)$/ }).click();
  await expect(web.locator('pre')).toHaveText('2');
  await page.locator('#tool-tab-apps').click();
  await expect(page.locator('#tool-panel-apps input[type=file]')).toHaveAttribute('accept', '.apk,.apks,.zip');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(operations).toEqual(['start', 'stop', 'clear']);
});
