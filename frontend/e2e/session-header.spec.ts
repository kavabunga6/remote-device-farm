import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

for (const [width, height, theme, scale] of [[1366, 768, 'light', 1], [1920, 1080, 'dark', 1], [1366, 800, 'dark', 1.25], [1920, 1080, 'light', 1.25], [390, 844, 'light', 1], [390, 844, 'dark', 1.25]] as const) {
  test(`compact session header keeps every layout within ${width}x${height} ${theme} ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/sessions/' + sessionId, async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.session.label = 'Проверка длинного названия сессии и выравнивания всех элементов';
      data.session.audioEnabled = true;
      data.session.idleExpiresAt = new Date(Date.now() + 3600000).toISOString();
      await route.fulfill({ response, json: data });
    });
    await page.goto('/#/session/' + sessionId);
    await expect(page.getByRole('button', { name: 'Включить или выключить звук Android', exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');
    await expect(page.locator('.session-media-badge[data-media=audio]')).toHaveAttribute('data-state', 'waiting');
    await page.screenshot({ path: `../.tmp-ui/media-status/${width}-${theme}-${scale}-initial.png` });
    const geometry = await page.locator('.session-heading').evaluate(element => {
      const selectors = ['.session-title-row','.session-status-row','.session-status-items','.status-badge','.session-media-status','.session-media-badge[data-media=video]','.session-media-badge[data-media=audio]','.adb-title-badge','.session-metadata','.workspace-mode-bar'];
      return Object.fromEntries(selectors.map(selector => {
        const node = element.querySelector(selector)!; const rect = node.getBoundingClientRect();
        return [selector, { x:rect.x,y:rect.y,width:rect.width,height:rect.height }];
      }));
    });
    writeFileSync(`../.tmp-ui/media-status/${width}-${theme}-${scale}-geometry.json`, JSON.stringify(geometry,null,2));
    const header = page.locator('.session-heading');
    const modes = page.getByRole('group', { name: 'Компоновка сессии' });
    if (width > 650) await expect.poll(() => header.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(74 * scale);
    if (width > 650) await expect.poll(() => page.evaluate(() => {
      const status = document.querySelector('.session-heading .status-badge')!.getBoundingClientRect();
      const modes = document.querySelector('.workspace-mode-bar')!.getBoundingClientRect();
      const header = document.querySelector('.session-heading')!.getBoundingClientRect();
      const badges = [...document.querySelectorAll('.session-status-items .session-badge')].map(el => el.getBoundingClientRect());
      const centers = badges.map(rect => rect.top + rect.height / 2);
      return Math.max(Math.max(...centers) - Math.min(...centers), Math.max(...badges.map(rect => rect.height)) - Math.min(...badges.map(rect => rect.height)), Math.abs(status.top + status.height / 2 - modes.top - modes.height / 2), Math.abs(header.right - modes.right));
    })).toBeLessThanOrEqual(1);

    for (const name of (width > 650 ? ['Экран', 'Инструменты', 'Рядом'] : ['Экран', 'Инструменты', 'Экран'])) {
      await modes.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
      if (width > 650) await expect.poll(() => page.evaluate(() => {
        const panels = [...document.querySelectorAll('.viewer-panel,.terminal-panel')];
        return Math.max(...panels.filter(el => el.getBoundingClientRect().height > 0).map(el => el.getBoundingClientRect().bottom));
      })).toBeLessThanOrEqual(height - 6);
      if (width > 650) expect(await page.evaluate(() => scrollY)).toBe(0);
      if (name !== 'Инструменты') {
        const toolbar = await page.locator('.device-controls').evaluate(el => ({ bottom: el.getBoundingClientRect().bottom, overflow: el.scrollWidth - el.clientWidth }));
        const screenTop = await page.locator('.device-screen').evaluate(el => el.getBoundingClientRect().top);
        expect(toolbar.bottom).toBeLessThanOrEqual(screenTop);
        if (width > 650 && scale === 1) expect(toolbar.overflow).toBeLessThanOrEqual(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `../.tmp-ui/media-status/${width}-${theme}-${scale}.png` });
    const before = await page.locator('.workspace-grid').evaluate(el => el.getBoundingClientRect().top);
    await page.locator('.session-metadata summary').click();
    await expect(page.locator('.session-metadata-body')).toContainText('Трансляция');
    await expect(page.locator('.session-metadata-body')).toContainText('Звук');
    expect(await page.locator('.workspace-grid').evaluate(el => el.getBoundingClientRect().top)).toBe(before);
    await page.locator('.session-metadata summary').click();
    await page.getByRole('button', { name: 'Переименовать сессию' }).click();
    await expect(page.getByRole('textbox', { name: 'Название сессии', exact: true })).toBeInViewport();
    if (width > 650) expect(await header.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(74 * scale);
    await page.getByRole('textbox', { name: 'Название сессии', exact: true }).press('Escape');
  });
}

test('ADB settings keep connection commands accessible from the compact header', async ({ page, context }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto('/#/session/' + sessionId);
  const adb = page.getByRole('button', { name: 'Настроить ADB-подключение', exact: true });
  await expect(adb).toHaveText('ADB');
  await expect(adb).toHaveAttribute('aria-description', 'ADB-порт открыт');
  await adb.click();
  const menu = page.getByRole('group', { name: 'Доступ ADB', exact: true });
  await expect(menu).toBeVisible();
  const command = await menu.locator('.adb-copy-command code').innerText();
  await menu.getByRole('button', { name: /^Скопировать команду adb connect/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await expect(menu.locator('.adb-copy-command')).toContainText('Скопировано');
  await menu.getByRole('button', { name: 'Закрыть настройки ADB' }).click();
  await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: /Поделиться/ }).click();
  await expect(page.getByRole('dialog', { name: 'Доступ к сессии' })).toBeVisible();
});


test('Android mute sends its key while stream audio uses the audio API', async ({ page }) => {
  const inputs: Record<string, unknown>[] = [];
  const audioRequests: Record<string, unknown>[] = [];
  let audioEnabled = false;
  let currentSession: Record<string, unknown> = {};
  await page.exposeFunction('recordSessionInput', (data: Record<string, unknown>) => inputs.push(data));
  await page.addInitScript(() => {
    let Socket = window.WebSocket;
    Object.defineProperty(window, 'WebSocket', {
      configurable: true, get: () => Socket,
      set: (Next: typeof WebSocket) => {
        const Wrapped = function(url: string | URL, protocols?: string | string[]) {
          const socket = new Next(url, protocols);
          const send = socket.send.bind(socket);
          socket.send = data => {
            if (typeof data === 'string') {
              const message = JSON.parse(data);
              if (message.type === 'input') void (window as unknown as { recordSessionInput: (value: unknown) => Promise<void> }).recordSessionInput(message);
            }
            send(data);
          };
          return socket;
        };
        Object.setPrototypeOf(Wrapped, Next);
        Socket = Wrapped as unknown as typeof WebSocket;
      },
    });
  });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + sessionId, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.session.audioEnabled = audioEnabled;
    data.session.idleExpiresAt = new Date(Date.now() + 3600000).toISOString();
    currentSession = data.session;
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sessions/' + sessionId + '/input', async route => {
    inputs.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/sessions/' + sessionId + '/audio', async route => {
    const data = route.request().postDataJSON();
    audioRequests.push(data);
    audioEnabled = data.enabled;
    await route.fulfill({ json: { session: { ...currentSession, audioEnabled } } });
  });
  await page.goto('/#/session/' + sessionId);
  const androidMute = page.getByRole('button', { name: 'Включить или выключить звук Android', exact: true });
  await expect(androidMute).toBeEnabled();
  await androidMute.click();
  await expect.poll(() => inputs).toEqual([expect.objectContaining({ type: 'input', kind: 'key', keyCode: 164, epoch: expect.any(String), seq: 1, deadline: expect.any(Number) })]);
  expect(audioRequests).toEqual([]);
  const audio = page.locator('.session-media-badge[data-media=audio]');
  await expect(audio).toHaveAttribute('data-state', 'disabled');
  await page.getByRole('button', { name: 'Включить звук трансляции', exact: true }).click();
  await expect.poll(() => audioRequests).toEqual([{ enabled: true }]);
  await expect(audio).toHaveAttribute('data-state', 'waiting');
  expect(inputs).toHaveLength(1);
  await page.getByRole('button', { name: 'Выключить звук трансляции', exact: true }).click();
  await expect.poll(() => audioRequests).toEqual([{ enabled: true }, { enabled: false }]);
  await expect(audio).toHaveAttribute('data-state', 'disabled');
  expect(inputs).toHaveLength(1);
});
