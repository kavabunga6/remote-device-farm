import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sessionId = 'session-transition-qa';
const session = {
  id: sessionId, ownerId: 'u1', ownerName: 'admin', hostId: 'h1', hostName: 'worker-01',
  profileId: 'a11-gpu', profileName: 'Android 11 · NVIDIA GPU', state: 'starting',
  orientation: 'portrait', audioEnabled: false, networkEnabled: true,
  createdAt: '2026-01-01T00:00:00Z', startupProgress: { stage: 'booting' },
};
const missingResponse = { status: 404, json: { error: { code: 'not_found', message: 'Session not found' } } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type TransitionTrace = {
  workspaceMounted: boolean;
  missingToasts: Array<{ hash: string; homeVisible: boolean; sessionVisible: boolean }>;
};
type TracedWindow = Window & { sessionTransitionTrace: TransitionTrace };

async function observeTransitions(page: Page) {
  await page.addInitScript(() => {
    const trace: TransitionTrace = { workspaceMounted: false, missingToasts: [] };
    (window as TracedWindow).sessionTransitionTrace = trace;
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      if (document.querySelector('.workspace-grid, .device-screen')) trace.workspaceMounted = true;
      for (const toast of document.querySelectorAll('.notification-toast')) {
        if (seen.has(toast) || !toast.textContent?.includes('Сессия не найдена')) continue;
        seen.add(toast);
        trace.missingToasts.push({
          hash: location.hash,
          homeVisible: Array.from(document.querySelectorAll('h1')).some(heading => heading.textContent === 'Сессии'),
          sessionVisible: Boolean(document.querySelector('.session-layout')),
        });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [] } }));
}

test('a delayed session response shows startup immediately without mounting an empty emulator', async ({ page }) => {
  await page.clock.install();
  const requested = deferred(), reply = deferred();
  await observeTransitions(page);
  await page.route('**/api/sessions/' + sessionId, async route => {
    requested.resolve();
    await reply.promise;
    await route.fulfill({ json: { session } });
  });
  try {
    await page.goto('/#/session/' + sessionId);
    await requested.promise;
    const progress = page.locator('.session-startup-progress');
    await expect(progress).toBeVisible();
    // Several polling deadlines may pass while the first request is still unresolved.
    await page.clock.fastForward(15_000);
    await expect(progress).toBeVisible();
    await expect(page.locator('.workspace-grid, .workspace-mode-bar, .device-controls, .terminal-panel, .session-media')).toHaveCount(0);
    expect(await page.evaluate(() => (window as TracedWindow).sessionTransitionTrace.workspaceMounted)).toBe(false);
    reply.resolve();
    await expect(progress).toHaveAttribute('data-stage', 'booting');
    await expect(progress).toContainText('Загружаем Android');
    await expect(progress.locator('.is-current .activity-indicator')).toHaveCount(1);
    await expect(progress.locator('.is-complete .activity-indicator')).toHaveCount(0);
    expect(await page.evaluate(() => (window as TracedWindow).sessionTransitionTrace.workspaceMounted)).toBe(false);
  } finally { reply.resolve(); }
});

test('a missing session redirects to Sessions before displaying one toast', async ({ page }) => {
  const requested = deferred(), reply = deferred();
  await observeTransitions(page);
  await page.route('**/api/sessions/' + sessionId, async route => {
    requested.resolve();
    await reply.promise;
    await route.fulfill(missingResponse);
  });
  try {
    await page.goto('/#/session/' + sessionId);
    await requested.promise;
    await expect(page.locator('.notification-toast')).toHaveCount(0);
    reply.resolve();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeVisible();
    await expect(page.locator('.session-layout')).toHaveCount(0);
    await expect(page.locator('.notification-toast')).toHaveCount(1);
    await expect(page.locator('.notification-title')).toHaveText('Сессия не найдена');
    expect(await page.evaluate(() => (window as TracedWindow).sessionTransitionTrace.missingToasts)).toEqual([
      { hash: '#/overview', homeVisible: true, sessionVisible: false },
    ]);
  } finally { reply.resolve(); }
});

test('a delayed missing response cannot redirect or notify after leaving the session', async ({ page }) => {
  const requested = deferred(), reply = deferred();
  await observeTransitions(page);
  await page.route('**/api/sessions/' + sessionId, async route => {
    requested.resolve();
    await reply.promise;
    await route.fulfill(missingResponse);
  });
  try {
    await page.goto('/#/session/' + sessionId);
    await requested.promise;
    await page.getByRole('link', { name: 'API-токены', exact: true }).click();
    await expect(page).toHaveURL(/#\/tokens$/);
    await expect(page.locator('.session-layout')).toHaveCount(0);
    const responseReceived = page.waitForResponse(response => response.url().endsWith('/api/sessions/' + sessionId));
    reply.resolve();
    await (await responseReceived).finished();
    // Let the fetch continuation and its possible React updates finish before checking navigation.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/#\/tokens$/);
    await expect(page.locator('.notification-toast')).toHaveCount(0);
    expect(await page.evaluate(() => (window as TracedWindow).sessionTransitionTrace.missingToasts)).toEqual([]);
  } finally { reply.resolve(); }
});

test('a temporary session API error stays on the session and can be retried', async ({ page }) => {
  let unavailable = true;
  await observeTransitions(page);
  await page.route('**/api/sessions/' + sessionId, route => route.fulfill(unavailable
    ? { status: 503, json: { error: { code: 'unavailable', message: 'Сервер временно недоступен' } } }
    : { json: { session } }));
  await page.goto('/#/session/' + sessionId);
  const error = page.locator('.banner-error');
  await expect(error).toContainText('Сервер временно недоступен');
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
  await expect(page.locator('.notification-toast')).toHaveCount(0);
  unavailable = false;
  await error.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(page.locator('.session-startup-progress')).toHaveAttribute('data-stage', 'booting');
});

const failedNotice = (id: string, sessionId: string) => ({ id, sessionId, kind: 'session.failed',
  title: 'Не удалось запустить устройство', body: 'Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.',
  createdAt: new Date().toISOString() });

test('cleanup before the next poll shows one red startup failure with the session identity', async ({ page }) => {
  await page.clock.install();
  await observeTransitions(page);
  const notice = failedNotice('failed-before-cleanup', sessionId);
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [notice] } }));
  await page.route('**/api/me/notifications/read', route => route.fulfill({ json: { marked: 1 } }));
  await page.route('**/api/sessions/' + sessionId, route => route.fulfill(missingResponse));
  await page.goto('/#/session/' + sessionId);
  await expect(page).toHaveURL(/#\/overview$/);
  const toast = page.locator('.notification-toast');
  await expect(toast).toHaveCount(1);
  await expect(toast).toHaveClass(/notification-error/);
  await expect(toast.locator('.notification-title')).toHaveText(notice.title);
  await expect(toast.locator('.notification-message')).toHaveText(`Сессия #${sessionId.slice(0, 8)}. ${notice.body}`);
  await page.clock.fastForward(30_000);
  await expect(toast).toHaveCount(1);
  await expect(page.getByText('Сессия не найдена', { exact: true })).toHaveCount(0);
});

test('a delayed failure replaces the missing toast for the same session and preserves other failures', async ({ page }) => {
  await page.clock.install();
  await observeTransitions(page);
  let notices: ReturnType<typeof failedNotice>[] = [];
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: notices } }));
  await page.route('**/api/me/notifications/read', route => route.fulfill({ json: { marked: 0 } }));
  await page.route('**/api/sessions/' + sessionId, route => route.fulfill(missingResponse));
  await page.goto('/#/session/' + sessionId);
  await expect(page.locator('.notification-toast')).toHaveCount(1);
  await expect(page.locator('.notification-title')).toHaveText('Сессия не найдена');
  notices = [failedNotice('late-failure', sessionId), failedNotice('other-failure', 'other-session-qa')];
  await page.clock.fastForward(10_000);
  await expect(page.locator('.notification-toast')).toHaveCount(2);
  await expect(page.locator('.notification-error')).toHaveCount(2);
  await expect(page.getByText('Сессия не найдена', { exact: true })).toHaveCount(0);
  await expect(page.locator('.notification-message').filter({ hasText: '#session-' })).toHaveCount(1);
  await expect(page.locator('.notification-message').filter({ hasText: '#other-se' })).toHaveCount(1);
});

for (const [width, theme, fontScale] of [[1440, 'light', 1], [390, 'dark', 1.5]] as const) {
  test(`startup failure notification layout at ${width} ${theme} ${fontScale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await observeTransitions(page);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
      theme, fontScale, fontFamily: 'system', defaultAdbKeyId: null,
    } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [failedNotice('visual-failure', sessionId)] } }));
    await page.goto('/#/overview');
    const toast = page.locator('.notification-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toHaveClass(/notification-error/);
    await page.evaluate(() => document.fonts.ready);
    const box = await toast.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL(`../../.tmp-ui/startup-failure/toast-${width}-${theme}.png`, import.meta.url)) });
  });
}
