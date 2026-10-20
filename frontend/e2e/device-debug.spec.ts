import { expect, test } from '@playwright/test';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const variant of [
  { language: 'ru', theme: 'light', scale: 1, width: 1440 },
  { language: 'en', theme: 'dark', scale: 1.5, width: 1440 },
  { language: 'ru', theme: 'dark', scale: 1, width: 768 },
]) test('traffic and WebView tools ' + JSON.stringify(variant), async ({ page }, info) => {
  let recording = false; const operations: string[] = [];
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), variant.language);
  await page.setViewportSize({ width: variant.width, height: 1100 });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + id + '/network-inspector', async route => {
    if (route.request().method() === 'POST') {
      const p = route.request().postDataJSON(); operations.push(p.op);
      if (p.op === 'start') recording = true;
      if (p.op === 'stop') recording = false;
    }
    await route.fulfill({ json: { available: true, recording, proxyActive: recording, pcapBytes: 0, entries: [{
      id: 1, method: 'GET', url: 'https://example.test/api/a-long-resource-name/items?token=%5Bredacted%5D', startedAt: 1, status: 200, durationMs: 42, bytes: 256, requestHeaders: [], responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    }] } });
  });
  await page.route('**/api/sessions/' + id + '/network-inspector/har', route => route.fulfill({ headers: { 'content-disposition': 'attachment; filename="session.har"' }, json: { log: { version: '1.2', entries: [] } } }));
  await page.route('**/api/sessions/' + id + '/webviews', async route => {
    const op = route.request().method() === 'GET' ? 'list' : route.request().postDataJSON().op;
    await route.fulfill({ json: op === 'list' ? { pages: [{ target: 'webview_devtools_remote_1/page', title: 'Example checkout page', url: 'https://example.test/checkout' }] } : { result: { result: { value: op === 'document' ? '<html><body>Example checkout</body></html>' : 2 } } } });
  });
  await page.goto('/#/session/' + id);
  await page.getByRole('group', { name: /Компоновка сессии|Session layout/ }).getByRole('button', { name: /^(Инструменты|Tools)$/ }).click();
  await page.locator('#tool-tab-traffic').click();
  const traffic = page.locator('#tool-panel-traffic');
  await expect(traffic.locator('tbody tr')).toHaveCount(1);
  await traffic.getByRole('button', { name: /Начать запись|Start capture/ }).click();
  await expect(traffic.locator('[data-recording]')).toHaveAttribute('data-recording', 'true');
  await traffic.getByRole('button', { name: /Остановить запись|Stop capture/ }).click();
  await expect(traffic.locator('[data-recording]')).toHaveAttribute('data-recording', 'false');
  await page.evaluate(() => document.fonts.ready);
  const bounds = await traffic.locator('.device-debug-actions > *').evaluateAll(items => items.map(item => { const b = item.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }));
  for (let n = 1; n < bounds.length; n++) if (Math.abs(bounds[n]!.top - bounds[n - 1]!.top) < 5) {
    expect(Math.abs(bounds[n]!.top - bounds[n - 1]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds[n]!.bottom - bounds[n - 1]!.bottom)).toBeLessThanOrEqual(1);
  }
  await traffic.getByRole('button', { name: /example.test/ }).click();
  await expect(traffic.locator('pre')).toContainText('application/json');
  await traffic.screenshot({ path: info.outputPath('traffic.png') });
  const download = page.waitForEvent('download'); await traffic.getByRole('link', { name: 'HAR' }).click();
  expect((await download).suggestedFilename()).toBe('session.har');
  await page.locator('#tool-tab-webviews').click();
  const web = page.locator('#tool-panel-webviews');
  await web.getByRole('button', { name: /Прочитать HTML|Read HTML/ }).click();
  await expect(web.locator('pre')).toContainText('<html>');
  await web.locator('textarea').fill('1 + 1');
  await web.getByRole('button', { name: /^(Выполнить|Run)$/ }).click();
  await expect(web.locator('pre')).toHaveText('2');
  await web.screenshot({ path: info.outputPath('webview.png') });
  await page.locator('#tool-tab-apps').click();
  await expect(page.locator('#tool-panel-apps input[type=file]')).toHaveAttribute('accept', '.apk,.apks,.zip');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(operations).toEqual(['start', 'stop']);
});
