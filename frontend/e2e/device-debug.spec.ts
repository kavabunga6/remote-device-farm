import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';

test('traffic capture exposes idle, disconnected, limit and PCAP recovery states', async ({ page }) => {
  let stage = 0, stops = 0;
  const states = [
    { available: true, protocolVersion: 2, recording: false, proxyActive: false, entries: [], pcapState: 'none' },
    { available: true, protocolVersion: 2, captureId: 'b'.repeat(32), recording: true, proxyActive: false, entries: [],
      pcapRequested: true, pcapState: 'recording', rejectedConnections: 3 },
    { available: true, protocolVersion: 2, captureId: 'b'.repeat(32), recording: false, proxyActive: false, entries: [],
      stopReason: 'time_limit', pcapRequested: true, pcapState: 'finalizing', finalizing: true, pcapBytes: 24 },
    { available: true, protocolVersion: 2, captureId: 'b'.repeat(32), recording: false, proxyActive: false, entries: [],
      stopReason: 'time_limit', pcapRequested: true, pcapState: 'error', pcapBytes: 24 },
    { available: true, protocolVersion: 2, captureId: 'b'.repeat(32), recording: false, proxyActive: false, entries: [],
      stopReason: 'time_limit', pcapRequested: true, pcapState: 'stopped', pcapBytes: 24 },
  ];
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'en'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + id + '/network-inspector', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().op).toBe('stop');
      stops++; stage = 4;
    }
    await route.fulfill({ json: states[stage] });
  });
  await page.goto('/#/session/' + id);
  await page.getByRole('group', { name: 'Session layout' }).getByRole('button', { name: 'Tools', exact: true }).click();
  await page.locator('#tool-tab-traffic').click();
  const panel = page.locator('#tool-panel-traffic');
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true });
  await expect(panel.getByRole('button', { name: 'Start capture', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: /Record packets/ })).not.toBeChecked();
  await expect(panel.getByRole('checkbox', { name: /Retain HTTP/ })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(panel.getByRole('dialog', { name: 'Export', exact: true })).toBeVisible();
  await expect(panel.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Export', exact: true })).toBeFocused();
  stage = 1; await refresh.click();
  await expect(panel.locator('.traffic-capture-state')).toContainText('Device proxy disconnected');
  await expect(panel).toContainText('The proxy rejected 3 connections');
  await expect(panel.getByRole('button', { name: 'Stop capture', exact: true })).toBeEnabled();
  stage = 2; await refresh.click();
  await expect(panel.locator('.traffic-capture-state')).toContainText('Finalizing PCAP');
  await expect(panel.locator('.traffic-record')).toBeDisabled();
  await panel.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(panel.getByRole('button', { name: /^PCAP/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  stage = 3; await refresh.click();
  await expect(panel.getByRole('button', { name: /Retry/ })).toBeEnabled();
  await panel.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(panel.getByRole('button', { name: /^PCAP/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: /Retry/ }).click();
  await expect(panel.locator('.traffic-capture-state')).toContainText('10');
  await panel.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(panel.getByRole('button', { name: /^PCAP/ })).toBeEnabled();
  await page.keyboard.press('Escape');
  expect(stops).toBe(1);
});

for (const variant of [
  { language: 'ru', theme: 'light', scale: 1, width: 1440, layout: 'tools' },
  { language: 'en', theme: 'dark', scale: 1.5, width: 1440, layout: 'tools' },
  { language: 'ru', theme: 'dark', scale: 1, width: 768, layout: 'tools' },
  { language: 'en', theme: 'light', scale: 1, width: 1920, layout: 'split' },
  { language: 'ru', theme: 'dark', scale: 1.25, width: 1366, layout: 'split' },
]) test('traffic and WebView tools ' + JSON.stringify(variant), async ({ page }, info) => {
  let recording = false, updated = false, extra = false, cleared = false, bodies = false, packets = false, evicted = false;
  const captureId = 'a'.repeat(32);
  const pcap = Buffer.from('d4c3b2a1020004000000000000000000ffff000001000000', 'hex');
  const operations: string[] = [];
  const rows = () => cleared ? [] : Array.from({ length: extra ? 41 : 40 }, (_, n) => ({
    id: n + 1, method: n === 2 ? 'CONNECT' : n === 3 ? 'POST' : 'GET',
    url: n === 2 ? 'https://secure.example.test:443' : n === 1 ? 'http://assets.example.test/images/icon.png' : 'http://api.example.test/api/v1/items/' + (n + 1) + '?token=%5Bredacted%5D',
    startedAt: 1792492200 + n, status: n === 6 ? null : n === 3 ? 503 : 200, captureId,
    statusSource: n === 2 ? 'proxy' : 'upstream', outcome: n === 2 ? recording ? 'open' : 'stopped' : n === 4 ? 'error' : n === 5 || n === 6 ? 'stopped' : 'complete',
    phase: n === 2 && recording ? 'tunnel' : 'done', errorKind: n === 4 ? 'incomplete' : null, errorPhase: n === 4 ? 'receive' : null,
    durationMs: n === 2 ? recording ? null : 1000 : n === 0 && updated ? 1850 : 42 + n, elapsedMs: n === 2 ? recording ? 4000 : 1000 : 42 + n, bytes: 256 * (n + 1), bytesSent: 20, bytesReceived: 256 * (n + 1) - 20,
    timings: { connect: 10, send: 4, wait: 20, receive: n === 0 && updated ? 1816 : 8 + n },
    requestBody: { text: bodies ? '{"query":"sample"}' : null, truncated: false, reason: bodies ? null : 'disabled', mimeType: 'application/json', capturedBytes: bodies ? 18 : 0, limit: 4096 },
    responseBody: { text: bodies ? '{"message":"sample"}' : null, truncated: false, reason: bodies ? null : 'disabled', mimeType: 'application/json', capturedBytes: bodies ? 20 : 0, limit: 4096 },
    requestHeaders: n === 2 ? [] : [{ name: 'content-type', value: 'application/vnd.sample+json' }],
    responseHeaders: n === 2 ? [] : [{ name: 'content-type', value: 'application/json' }, { name: 'content-length', value: '256' }],
  })).filter(row => !evicted || row.id !== 1);
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), variant.language);
  await page.setViewportSize({ width: variant.width, height: 1000 });
  if (variant.layout === 'split') await page.addInitScript(() => localStorage.setItem('rdf-console-width', '460'));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + id + '/network-inspector', async route => {
    if (route.request().method() === 'POST') {
      const p = route.request().postDataJSON(); operations.push(p.op);
      if (p.op === 'start') { recording = true; bodies = p.captureBodies; packets = p.pcap; }
      if (p.op === 'pcap') { await route.fulfill({ json: { offset: 0, size: pcap.length, contentBase64: pcap.toString('base64'), captureId } }); return; }
      if (p.op === 'stop') recording = false;
      if (p.op === 'clear') cleared = true;
    }
    await route.fulfill({ json: { available: true, protocolVersion: 2, captureId, captureBodies: bodies, pcapRequested: packets, pcapState: packets ? recording ? 'recording' : 'stopped' : 'none', recording, proxyActive: recording, pcapBytes: packets ? pcap.length : 0, totalCaptured: extra ? 41 : 40, evicted: evicted ? 1 : 0, entries: rows() } });
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
  await expect(traffic.getByRole('button', { name: /^(Дерево|Tree)$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(traffic.locator('.traffic-tree-leaf')).toHaveCount(40);
  if (variant.layout === 'split') {
    await expect.poll(() => page.locator('.device-screen').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(150);
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { viewer: rect('.viewer-panel').width, device: rect('.device-screen').width,
        tools: rect('.terminal-panel').width, workspace: rect('.workspace-grid').width };
    });
    expect(geometry.viewer - geometry.device).toBeLessThanOrEqual(Math.max(26, 320 - geometry.device) + 1);
    expect(geometry.tools).toBeGreaterThan(geometry.workspace / 2);
  }
  const host = traffic.locator('.traffic-tree > .traffic-tree-node').first();
  const hostSummary = host.locator(':scope > summary');
  await expect(host.locator('.traffic-tree-children > .traffic-tree-node').first()).not.toHaveAttribute('open');
  await expect(traffic.locator('.traffic-tree > .traffic-tree-node > summary')).toHaveCount(3);
  await traffic.screenshot({ path: info.outputPath('traffic-hosts.png') });
  await hostSummary.press('ArrowLeft');
  await expect(host).not.toHaveAttribute('open');
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(host).not.toHaveAttribute('open');
  await search.fill('api.example.test GET items/1');
  await expect(host).toHaveAttribute('open');
  await expect(traffic.locator('[data-entry-id="1"]')).toBeVisible();
  await search.fill('');
  await expect(host).not.toHaveAttribute('open');
  await search.fill('no-matching-host-or-path');
  await expect(traffic).toContainText(/Нет запросов, подходящих|No requests match/);
  await search.fill('');
  await expect(host).not.toHaveAttribute('open');
  await hostSummary.press('ArrowRight');
  await expect(host).toHaveAttribute('open');
  await hostSummary.press('ArrowDown');
  await expect(host.locator('.traffic-tree-children > .traffic-tree-node > summary').first()).toBeFocused();
  for (let depth = 0; depth < 8 && !await traffic.locator('[data-entry-id="1"]').isVisible(); depth++)
    await host.locator('.traffic-tree-node:not([open]) > summary:visible').first().press('ArrowRight');
  await traffic.screenshot({ path: info.outputPath('traffic-default-tree-list.png') });
  await traffic.locator('[data-entry-id="1"]').click();
  const nextRequest = details.getByRole('button', { name: /^(Следующий запрос|Next request)$/ });
  const previousRequest = details.getByRole('button', { name: /^(Предыдущий запрос|Previous request)$/ });
  await expect(previousRequest).toBeDisabled();
  await nextRequest.click();
  await expect(details.locator('.traffic-full-url')).toContainText('/items/4?');
  await expect(nextRequest).toBeFocused();
  await previousRequest.click();
  await expect(details.locator('.traffic-full-url')).toContainText('/items/1?');
  await details.locator('.traffic-detail-body').press('Alt+ArrowDown');
  await expect(details.locator('.traffic-full-url')).toContainText('/items/4?');
  await details.locator('.traffic-detail-body').press('Alt+ArrowUp');
  await expect(details.locator('.traffic-full-url')).toContainText('/items/1?');
  await traffic.screenshot({ path: info.outputPath('traffic-default-tree.png') });
  await page.screenshot({ path: info.outputPath('traffic-default-tree-page.png') });
  const back = details.getByRole('button', { name: /К списку запросов|Back to requests/ });
  if (await back.isVisible()) await back.click();
  await traffic.getByRole('button', { name: /^(По времени|Sequence)$/ }).click();
  await expect(traffic.locator('tbody tr')).toHaveCount(40);
  await traffic.getByRole('button', { name: /^(Параметры|Settings)$/ }).click();
  await traffic.getByRole('checkbox', { name: /предпросмотр текстовых|Retain HTTP/ }).check();
  await traffic.getByRole('checkbox', { name: /Записывать пакеты|Record packets/ }).check();
  await page.screenshot({ path: info.outputPath('traffic-settings.png') });
  await traffic.getByRole('button', { name: /^(Параметры|Settings)$/ }).click();
  await expect(traffic.getByRole('button', { name: /Начать запись|Start capture/ }).locator('span').last()).toBeVisible();
  await traffic.getByRole('button', { name: /Начать запись|Start capture/ }).click();
  await expect(traffic.locator('.traffic-capture-state')).toHaveAttribute('data-recording', 'true');
  await expect(traffic.getByRole('button', { name: /Очистить список|Clear list/ })).toBeDisabled();
  await traffic.getByRole('button', { name: /^(Параметры|Settings)$/ }).click();
  await expect(traffic.getByRole('checkbox', { name: /Записывать пакеты|Record packets/ })).toBeDisabled();
  await expect(traffic.getByRole('dialog', { name: /^(Параметры|Settings)$/ })).toContainText(/Остановите запись, чтобы изменить|Stop capture to change/);
  await page.screenshot({ path: info.outputPath('traffic-recording-settings.png') });
  await page.keyboard.press('Escape');
  await traffic.getByRole('button', { name: /Остановить запись|Stop capture/ }).click();
  await expect(traffic.locator('.traffic-capture-state')).toHaveAttribute('data-recording', 'false');
  await expect(traffic.locator('tr:has([data-entry-id="5"]) .traffic-status')).toContainText(/Обрыв|Interrupted/);
  await expect(traffic.locator('tr:has([data-entry-id="6"]) .traffic-status')).toContainText(/Снимок|Snapshot/);
  await expect(traffic.locator('tr:has([data-entry-id="7"]) .traffic-status')).toHaveText(/Снимок|Snapshot/);
  await traffic.locator('[data-entry-id="1"]').click();
  await expect(traffic.locator('tr[data-selected=true]')).toHaveCount(1);
  await traffic.screenshot({ path: info.outputPath('traffic-initial.png') });
  await page.screenshot({ path: info.outputPath('traffic-page-initial.png') });
  await details.getByRole('tab', { name: /^(Ответ|Response)$/ }).click();
  await expect(details.locator('.traffic-headers').first()).toContainText('application/json');
  await expect(details.locator('.traffic-headers').first()).not.toContainText('application/vnd.sample');
  await details.getByRole('tab', { name: /^(Запрос|Request)$/ }).click();
  await expect(details.locator('.traffic-headers').first()).toContainText('application/vnd.sample+json');
  await expect(details.locator('.traffic-headers').first()).not.toContainText('content-length');
  await details.getByRole('tab', { name: /^(Обзор|Overview)$/ }).click();
  updated = true;
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(details.locator('.traffic-summary')).toContainText(/1[,.]9/);
  const compact = await traffic.locator('.traffic-workspace').getAttribute('data-wide') === 'false';
  if (compact) {
    await search.fill('POST 503');
    await expect(list).toBeVisible();
    await expect(details).toBeHidden();
    await expect(traffic.locator('tbody tr')).toHaveCount(1);
    await traffic.locator('[data-entry-id="4"]').click();
    await search.fill('');
    await expect(list).toBeVisible();
    await traffic.locator('[data-entry-id="4"]').click();
    await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('errors');
    await expect(list).toBeVisible();
    await expect(traffic.locator('tbody tr')).toHaveCount(2);
    await traffic.locator('[data-entry-id="5"]').click();
    await expect(previousRequest).toBeEnabled();
    await expect(nextRequest).toBeDisabled();
    await previousRequest.click();
    await expect(details.locator('.traffic-full-url')).toContainText('/items/4?');
    await traffic.getByRole('button', { name: /^(Дерево|Tree)$/ }).click();
    await expect(list).toBeVisible();
    await expect(traffic.locator('.traffic-tree-leaf')).toHaveCount(2);
    await traffic.getByRole('button', { name: /^(По времени|Sequence)$/ }).click();
    await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('all');
    await traffic.locator('[data-entry-id="1"]').click();
    await expect(details).toBeVisible();
    await expect(list).toBeHidden();
    await expect(details.getByRole('button', { name: /К списку запросов|Back to requests/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('traffic-page.png') });
    await traffic.screenshot({ path: info.outputPath('traffic.png') });
    await details.getByRole('button', { name: /К списку запросов|Back to requests/ }).click();
    await expect(list).toBeVisible();
    await expect(traffic.locator('[data-entry-id="1"]')).toBeFocused();
    await traffic.screenshot({ path: info.outputPath('traffic-list.png') });
    const toolbarHeight = await traffic.locator('.traffic-toolbar').evaluate(el => el.getBoundingClientRect().height);
    expect(toolbarHeight).toBeLessThan(72);
    await search.fill('POST 503');
    await expect(traffic.locator('tbody tr')).toHaveCount(1);
    await traffic.locator('[data-entry-id="4"]').click();
    await expect(details).toContainText(/HTTP-ошибка|HTTP error/);
    await details.getByRole('button', { name: /К списку запросов|Back to requests/ }).click();
    await traffic.getByRole('button', { name: /^(Экспорт|Export)$/ }).click();
    const shown = page.waitForEvent('download');
    await traffic.getByRole('button', { name: /^HAR · (список|shown)/ }).click();
    expect(JSON.parse(await readFile((await (await shown).path())!, 'utf8')).log.entries).toHaveLength(1);
    await expect(traffic.getByRole('dialog', { name: /^(Экспорт|Export)$/ })).not.toBeVisible();
    if (variant.layout === 'split') {
      await traffic.getByRole('button', { name: /Развернуть|Expand/ }).click();
      await expect(layout.getByRole('button', { name: /^(Инструменты|Tools)$/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(list).toBeVisible();
      // Enlarged text may still require compact request details at the full workspace width.
      if (await traffic.locator('.traffic-workspace').getAttribute('data-wide') === 'true') await expect(details).toBeVisible();
      else await expect(details).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(operations).toEqual(['start', 'stop']);
    return;
  }
  // A new snapshot updates the selected entry without moving the list.
  await list.evaluate(el => { el.scrollTop = 180; });
  const scroll = await list.evaluate(el => el.scrollTop);
  await traffic.getByRole('button', { name: /Заморозить обновление|Freeze list/ }).click();
  extra = true;
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(traffic.locator('tbody tr')).toHaveCount(40);
  expect(await list.evaluate(el => el.scrollTop)).toBe(scroll);
  await traffic.getByRole('button', { name: /^(Экспорт|Export)$/ }).click();
  const frozenDownload = page.waitForEvent('download');
  await traffic.getByRole('button', { name: /^HAR · (список|shown)/ }).click();
  const frozenFile = await frozenDownload;
  const frozenHar = JSON.parse(await readFile((await frozenFile.path())!, 'utf8'));
  expect(frozenHar.log.entries).toHaveLength(40);
  expect(frozenHar.log._totalCaptured).toBe(40);
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
  await expect(nextRequest).toBeDisabled();
  await previousRequest.click();
  await expect(details.locator('.traffic-full-url')).toContainText('/items/4?');
  await nextRequest.click();
  await expect(details.locator('.traffic-full-url')).toContainText('/images/icon.png');
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
  await traffic.locator('[data-entry-id="5"]').click();
  await expect(details).toContainText(/полного тела|declared body/);
  await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('errors');
  await expect(traffic.locator('tbody tr')).toHaveCount(2);
  await traffic.getByRole('combobox', { name: /Фильтр трафика|Traffic filter/ }).selectOption('all');
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
  if (variant.layout === 'split') expect(box!.width).toBeGreaterThan(800);
  await traffic.screenshot({ path: info.outputPath('traffic.png') });
  await page.screenshot({ path: info.outputPath('traffic-page.png') });
  const divider = traffic.getByRole('separator');
  const direction = await divider.getAttribute('aria-orientation') === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  await divider.press(direction);
  await expect(divider).toHaveAttribute('aria-valuenow', '63');
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '58');
  await traffic.getByRole('button', { name: /^(Дерево|Tree)$/ }).click();
  await search.fill('api.example.test GET items/1');
  await expect(traffic.locator('.traffic-tree-node').first()).toContainText('http://api.example.test');
  await traffic.locator('[data-entry-id="1"]').click();
  await traffic.screenshot({ path: info.outputPath('traffic-structure.png') });
  await traffic.getByRole('button', { name: /^(Экспорт|Export)$/ }).click();
  const download = page.waitForEvent('download'); await traffic.getByRole('button', { name: /^HAR · (список|shown)/ }).click();
  expect((await download).suggestedFilename()).toBe('traffic-visible-' + id.slice(0, 8) + '.har');
  await traffic.getByRole('button', { name: /^(Экспорт|Export)$/ }).click();
  const packetsDownload = page.waitForEvent('download'); await traffic.getByRole('button', { name: /^PCAP/ }).click();
  expect((await packetsDownload).suggestedFilename()).toBe('session-' + id.slice(0, 8) + '.pcap');
  evicted = true;
  await traffic.getByRole('button', { name: /Обновить|Refresh/ }).click();
  await expect(details).toContainText(/вытеснен из буфера|left the buffer/);
  await expect(details.locator('.traffic-full-url')).toContainText('/items/1?');
  await search.fill('');
  await traffic.getByRole('button', { name: /^(Параметры|Settings)$/ }).click();
  await expect(traffic.getByRole('checkbox', { name: /предпросмотр текстовых|Retain HTTP/ })).toBeVisible();
  await expect(traffic.getByRole('dialog', { name: /^(Параметры|Settings)$/ })).toContainText(/учётные данные|credentials/);
  await traffic.getByRole('button', { name: /^(Параметры|Settings)$/ }).click();
  await traffic.getByRole('button', { name: /Очистить список|Clear list/ }).click();
  await expect(traffic.locator('.traffic-tree-node')).toHaveCount(0);
  await expect(details).toContainText(/Выберите запрос|Inspect a request/);
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
  expect(operations).toEqual(['start', 'stop', 'pcap', 'clear']);
});
