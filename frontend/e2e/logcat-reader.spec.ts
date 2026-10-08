import { expect, test, type Page } from '@playwright/test';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const rows = (start: number, count: number) => Array.from({ length: count }, (_, n) => ({
  ts: '10-08 02:12:00.' + String(start+n).padStart(6, '0'), pid: 301, tid: 302,
  level: n%11 === 0 ? 'E' : 'I', tag: 'ActivityManager',
  message: `Entry ${start+n}: a typical Android log message for reading and selection`,
}));
async function fixture(page: Page, width = 1366, height = 768, theme = 'light', scale = 1) {
  let requests = 0, queued: ReturnType<typeof rows> = [];
  await page.setViewportSize({ width, height }); await page.clock.install();
  await page.route('**/api/me/notifications', r => r.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/me/preferences', r => r.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system' } } }));
  await page.route('**/api/sessions/*/logcat/apps', r => r.fulfill({ json: { apps: [{ packageName: 'com.example.very.long.application.name', uid: 10100 }] } }));
  await page.route('**/api/sessions/*/logcat?*', r => {
    requests++;
    const params = new URL(r.request().url()).searchParams;
    const entries = params.has('since') ? queued : rows(0, 2500); queued = [];
    const packageName = params.get('packageName');
    return r.fulfill({ json: { entries, cursor: { since: entries.at(-1)?.ts || '10-08 02:12:00.000000', skip: requests },
      app: packageName ? { packageName, uid: 10100, pids: [301], sharedPackages: [] } : null } });
  });
  await page.goto('/#/session/' + id);
  if (width < 1201) await page.getByRole('button', { name: 'Инструменты', exact: true }).click();
  await page.getByRole('tab', { name: 'Логкат', exact: true }).click();
  await expect(page.locator('.log-row')).toHaveCount(2000); await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.log-panel')).toBeVisible();
  return { requests: () => requests, push: async (start: number, count: number) => {
    queued = rows(start, count);
    const response = page.waitForResponse(r => /\/logcat\?/.test(r.url()));
    await page.clock.fastForward(2001); await (await response).finished(); await page.clock.runFor(50);
  } };
}
const state = (page: Page) => page.locator('.log-viewport').evaluate(e => ({
  top: e.scrollTop, bottom: e.scrollHeight-e.clientHeight-e.scrollTop, text: e.textContent, selection: getSelection()?.toString(),
}));

test('reading history preserves lines, position and selection through buffer eviction', async ({ page }) => {
  const feed = await fixture(page), viewport = page.locator('.log-viewport');
  expect((await state(page)).bottom).toBeLessThanOrEqual(1);
  await viewport.focus(); await viewport.press('Home');
  await expect(page.locator('.log-reader-bar')).toContainText('Чтение истории');
  await expect.poll(async () => (await state(page)).top).toBe(0);
  await viewport.evaluate(e => {
    const box = e.getBoundingClientRect();
    const message = Array.from(e.querySelectorAll('.log-message')).find(e => e.getBoundingClientRect().top >= box.top && e.getBoundingClientRect().bottom <= box.bottom)!;
    const range = document.createRange(); range.selectNodeContents(message);
    getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
  });
  const reading = await state(page); expect(reading.selection).toContain('Entry');
  for (const start of [2500, 4500, 6500]) await feed.push(start, 2000);
  expect(await state(page)).toEqual(reading);
  await page.getByRole('button', { name: 'К новым записям', exact: true }).click();
  await expect(viewport.locator('.log-row').last()).toContainText('Entry 8499:');
  expect((await state(page)).bottom).toBeLessThanOrEqual(1);
  await expect(page.locator('.log-reader-bar')).toContainText('Новые записи');
});

test('pause stops polling, resume catches up, and error navigation scrolls only the log', async ({ page }) => {
  const feed = await fixture(page);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const count = feed.requests(), frozen = await state(page);
  await page.clock.fastForward(30000); expect(feed.requests()).toBe(count); expect(await state(page)).toEqual(frozen);
  await expect(page.locator('.log-reader-bar')).toContainText('Обновление на паузе');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect.poll(feed.requests).toBeGreaterThan(count);
  const top = await page.locator('.log-panel .log-head').evaluate(e => e.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Следующая ошибка', exact: true }).click();
  await expect(page.locator('.log-row.current')).toHaveCount(1);
  await expect(page.locator('.log-reader-bar')).toContainText('Чтение истории');
  expect(await page.locator('.log-panel .log-head').evaluate(e => e.getBoundingClientRect().top)).toBe(top);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('combobox', { name: 'Приложение', exact: true }).selectOption('com.example.very.long.application.name');
  await expect(page.locator('.log-app-state')).toContainText('Приложение запущено');
  await page.getByRole('combobox', { name: 'Уровень', exact: true }).selectOption('E');
  await expect(page.locator('.log-row')).not.toHaveCount(0);
  await expect(page.locator('.log-row:not(.level-E):not(.level-F)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Регулярное выражение', exact: true }).click();
  await page.getByRole('textbox', { name: 'Поиск по журналу' }).fill('(');
  await expect(page.locator('.log-regex-error')).toBeVisible();
});

for (const [width, height, theme, scale] of [[1366,768,'light',1],[1440,900,'dark',1.25],[390,844,'light',1.25],[390,844,'dark',1]] as const) {
  test(`log controls and space at ${width} ${theme} ${scale}`, async ({ page }) => {
    await fixture(page, width, height, theme, scale);
    const panel = page.locator('.log-panel');
    const geometry = await panel.evaluate(e => {
      const controls = Array.from(e.querySelectorAll('.log-filter-field select,.log-app-select-row>.log-control'));
      return { height: e.clientHeight, logHeight: e.querySelector('.log-viewport')!.clientHeight, overflow: e.scrollHeight-e.clientHeight,
        tops: controls.map(e => e.getBoundingClientRect().top), bottoms: controls.map(e => e.getBoundingClientRect().bottom),
        header: Array.from(e.querySelectorAll('.log-head .log-control')).map(e => e.getBoundingClientRect().height) };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.logHeight/geometry.height).toBeGreaterThan(width>650 ? .55 : .4);
    expect(Math.max(...geometry.tops)-Math.min(...geometry.tops)).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.bottoms)-Math.min(...geometry.bottoms)).toBeLessThanOrEqual(1);
    expect(Math.max(...geometry.header)-Math.min(...geometry.header)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await expect(panel.locator('.log-stats,.log-foot')).toHaveCount(0);
    await expect(page.locator('.text-send')).not.toBeVisible();
    await page.screenshot({ path: `../.tmp-ui/logcat/reader-${width}-${theme}.png` });
    for (let n=0;n<2;n++) await page.getByRole('button', { name: 'Увеличить шрифт Логката' }).click();
    expect(await page.locator('.log-viewport').evaluate(e => getComputedStyle(e).fontSize)).toBe('15px');
    expect(await page.evaluate(() => localStorage.getItem('rdf-logcat-font-size'))).toBe('15');
    await page.locator('.log-menu>summary').click();
    await expect(page.getByRole('button', { name: 'Скачать .log', exact: true })).toBeInViewport();
    await page.locator('.log-menu>summary').press('Escape');
    await expect(page.locator('.log-menu')).not.toHaveAttribute('open');
    await page.reload();
    if (width<1201) await page.getByRole('button', { name: 'Инструменты', exact: true }).click();
    await page.getByRole('tab', { name: 'Логкат', exact: true }).click();
    await expect(page.locator('.log-viewport')).toBeVisible();
    expect(await page.locator('.log-viewport').evaluate(e => getComputedStyle(e).fontSize)).toBe('15px');
  });
}
