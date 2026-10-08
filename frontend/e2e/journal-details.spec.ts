import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditRecord, RentalRecord, ServiceLogRecord } from '../src/settings-api';

test.use({ timezoneId: 'Europe/Moscow' });

const rental: RentalRecord = {
  id: '01a0fa51-49bc-7021-8ece-6f1bd2839976',
  sessionId: 'e2420252-f0b6-47f2-96f2-4445e274d15d',
  ownerUserId: 'b2e30c9e-3df0-4e5b-98ce-cdfd224a8c7c',
  ownerUsername: 'qa-user',
  hostId: 'h1',
  hostName: 'worker-01',
  profileId: 'android-10-google-apis-x86_64',
  profileName: 'Android 10 · Google APIs',
  createdAt: '2026-10-04T13:31:00.000Z',
  startedAt: '2026-10-04T13:32:12.000Z',
  endedAt: '2026-10-04T14:45:32.000Z',
  finalState: 'stopping',
};
const liveSessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const action: AuditRecord = {
  id: 'f8321b13-1e56-477c-9f83-cb3dcb1f6dc0', occurredAt: rental.endedAt!,
  actorUserId: rental.ownerUserId, actorUsername: rental.ownerUsername, subjectUserId: null,
  action: 'session.release_requested', outcome: 'denied', targetType: 'session', targetId: liveSessionId,
};
const systemFailure: AuditRecord = {
  ...action, id: 'system-failure-event', action: 'session.failed',
  actorUserId: null, actorUsername: null, outcome: 'success', targetId: rental.sessionId,
};
const log: ServiceLogRecord = {
  id: 'f790e8a3-1834-48ab-8611-14ea3e7d8e8c', occurredAt: rental.endedAt!,
  code: 'agent.offline', service: 'agent', severity: 'warning', hostId: 'h1', sessionId: rental.sessionId,
};

async function mockJournal(page: Page) {
  await page.route('**/api/admin/rentals?*', route => route.fulfill({ json: {
    rentals: [rental, { ...rental, id: 'failed-rental', sessionId: 'failed-session', profileName: 'Android 11 · AOSP', finalState: 'failed' }], nextCursor: null,
  } }));
  await page.route('**/api/admin/audit?*', route => route.fulfill({ json: { events: [action, systemFailure], nextCursor: null } }));
  await page.route('**/api/admin/logs?*', route => route.fulfill({ json: { events: [log], nextCursor: null } }));
}

async function expectContained(dialog: Locator, page: Page) {
  const viewport = page.viewportSize()!;
  const size = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, overflow: element.scrollWidth - element.clientWidth };
  });
  expect(size.left).toBeGreaterThanOrEqual(0);
  expect(size.top).toBeGreaterThanOrEqual(0);
  expect(size.right).toBeLessThanOrEqual(viewport.width);
  expect(size.bottom).toBeLessThanOrEqual(viewport.height);
  expect(size.overflow).toBeLessThanOrEqual(1);
}

test('ended rental has readable summary, preserves technical data and fits desktop and narrow windows', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockJournal(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/admin/journal');
  await page.getByRole('button', { name: rental.profileName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: rental.profileName });
  await expect(dialog).toBeVisible();
  const technical = dialog.locator('details').filter({ has: page.locator('summary', { hasText: 'Технические данные' }) });
  await expect(technical).not.toHaveAttribute('open', '');
  const summary = await dialog.innerText();
  expect(summary).toContain('Завершена');
  expect(summary).toContain(rental.ownerUsername);
  expect(summary).toContain(rental.hostName);
  expect(summary).toMatch(/4 окт\.? 2026/);
  expect(summary).toContain('16:31');
  expect(summary).toContain('16:32');
  expect(summary).toContain('17:45');
  expect(summary).not.toContain(rental.createdAt);
  expect(summary).not.toContain(rental.sessionId);
  expect(summary).not.toContain('stopping');
  await expect(dialog.getByRole('link', { name: 'Открыть сессию' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Открыть узел' })).toHaveAttribute('href', /host=h1/);
  const width = (await dialog.boundingBox())!.width;
  expect(width).toBeGreaterThanOrEqual(700);
  expect(width).toBeLessThanOrEqual(800);
  await expectContained(dialog, page);
  await dialog.screenshot({ path: '../.tmp-ui/journal-details-light.png' });

  await dialog.getByRole('button', { name: 'Копировать сведения' }).click();
  await expect(dialog.getByRole('status')).toContainText('Сведения скопированы');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const raw of [rental.id, rental.sessionId, rental.ownerUserId, rental.createdAt, rental.startedAt!, rental.endedAt!, 'stopping']) expect(copied).toContain(raw);
  await technical.locator('summary').click();
  for (const raw of [rental.id, rental.sessionId, rental.ownerUserId, rental.createdAt, rental.startedAt!, rental.endedAt!, 'stopping']) await expect(technical).toContainText(raw);
  await expectContained(dialog, page);
  await technical.locator('summary').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
  await expectContained(dialog, page);
  await dialog.screenshot({ path: '../.tmp-ui/journal-details-dark.png' });

  await page.setViewportSize({ width: 390, height: 700 });
  await expectContained(dialog, page);
  await technical.locator('summary').click();
  await expectContained(dialog, page);
  await expect(dialog.getByRole('button', { name: 'Закрыть подробности' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть подробности' }).click();
  await expect(dialog).toHaveCount(0);
});

test('failed rentals remain errors and action and service enums are readable', async ({ page }) => {
  await mockJournal(page);
  await page.goto('/#/admin/journal');
  await page.getByRole('button', { name: 'Android 11 · AOSP', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.locator('.journal-event-badge')).toHaveText('Завершена с ошибкой');
  expect(await dialog.innerText()).not.toContain('failed');
  await dialog.getByRole('button', { name: 'Закрыть подробности' }).click();

  await page.getByRole('tab', { name: 'Действия', exact: true }).click();
  await page.getByRole('button', { name: 'Освобождение запрошено', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Отказ');
  expect(await dialog.innerText()).not.toContain('denied');
  expect(await dialog.innerText()).not.toContain('session.release_requested');
  await expect(dialog.getByRole('link', { name: 'Открыть сессию' })).toHaveAttribute('href', '#/session/' + liveSessionId);
  await dialog.locator('summary', { hasText: 'Технические данные' }).click();
  await expect(dialog.locator('details')).toContainText(action.action);
  await expect(dialog.locator('details')).toContainText(action.outcome);
  await expect(dialog.locator('details')).toContainText(action.targetId!);
  await dialog.getByRole('button', { name: 'Закрыть подробности' }).click();

  await page.getByRole('button', { name: 'Ошибка сессии', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('.journal-event-badge')).toHaveText('Ошибка');
  await expect(dialog.getByText('Событие сессии', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Система', { exact: true })).toBeVisible();
  expect(await dialog.innerText()).not.toContain('Успешно');
  expect(await dialog.innerText()).not.toContain('success');
  await dialog.locator('summary', { hasText: 'Технические данные' }).click();
  await expect(dialog.locator('details')).toContainText('session.failed');
  await expect(dialog.locator('details')).toContainText('success');
  await dialog.getByRole('button', { name: 'Закрыть подробности' }).click();

  await page.getByRole('tab', { name: 'Логи сервиса', exact: true }).click();
  await page.getByRole('button', { name: 'Агент отключён', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Предупреждение');
  await expect(dialog.getByText('Агент', { exact: true })).toBeVisible();
  expect(await dialog.innerText()).not.toContain('warning');
  expect(await dialog.innerText()).not.toContain('agent.offline');
  await expect(dialog.getByRole('link', { name: 'Открыть сессию' })).toHaveCount(0);
  await dialog.locator('summary', { hasText: 'Технические данные' }).click();
  for (const raw of [log.id, log.occurredAt, log.code, log.severity, log.service]) await expect(dialog.locator('details')).toContainText(raw);
  await expectContained(dialog, page);
});


test('archived session diagnostic is a readable text log, filters by session and keeps raw failure details', async ({page})=>{
  await page.route('**/api/admin/session-diagnostics?*',route=>{
    expect(new URL(route.request().url()).searchParams.get('session')).toBe(rental.sessionId);
    return route.fulfill({json:{events:[
      {...log,id:'1',code:'session.start_requested',message:'Запрос запуска Android 16'},
      {...log,id:'2',code:'session.start_failed',severity:'error',message:'Vulkan initialization failed\nExit code: 139'},
      {...log,id:'3',code:'session.released',message:'Слот освобождён'},
    ],nextCursor:'3',hasMore:false}});
  });
  await page.goto('/#/admin/journal?tab=logs&session='+rental.sessionId);
  const stream=page.getByRole('log',{name:'Лог жизненного цикла сессии'});
  await expect(stream).toContainText('Vulkan initialization failed');
  await expect(stream.locator('pre').first()).toContainText('Запрос запуска Android 16');
  await expect(stream.locator('pre').last()).toContainText('Слот освобождён');
  await expect(stream.locator('[data-severity=error]')).toContainText('Exit code: 139');
  await expect(page.getByRole('button',{name:'Обновить',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  if(await page.locator('.sidebar').evaluate(el=>el.classList.contains('mobile-open')))await page.getByRole('button',{name:'Закрыть меню'}).click();
  await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await page.screenshot({path:'../.tmp-ui/device-proxy/session-diagnostics-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});
