import { expect, test } from '@playwright/test';
import type { EnvState } from '../src/env-api';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const initialEnv: EnvState = {
  darkMode: 'no', fontScale: 1, animations: true, showTouches: false, pointerLocation: false, timezone: 'UTC',
  size: { physical: '1080x1920', override: null }, density: { physical: 420, override: null },
  battery: { level: 100, charging: 'ac' },
  proxy: { enabled: false, host: '', port: 0 },
};

test('screen controls apply numeric values and reset to device defaults', async ({ page }) => {
  const env = structuredClone(initialEnv);
  const changes: { op: string; params: Record<string, number | boolean> }[] = [];
  await page.route(`**/api/sessions/${sessionId}/env`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { env } });
    const change = route.request().postDataJSON();
    changes.push(change);
    if (change.op === 'display_density') env.density!.override = change.params.reset ? null : change.params.dpi;
    if (change.op === 'display_size') env.size!.override = change.params.reset ? null : `${change.params.width}x${change.params.height}`;
    if (change.op === 'animations') env.animations = change.params.enabled;
    if (change.op === 'show_touches') env.showTouches = change.params.enabled;
    await route.fulfill({ json: { result: { applied: true } } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/#/session/${sessionId}`);
  await page.getByRole('tab', { name: 'Среда', exact: true }).click();
  const card = page.locator('.env-appearance');
  await card.locator('summary').click();
  const dpi = card.getByRole('spinbutton', { name: 'Плотность экрана, DPI' });
  const width = card.getByRole('spinbutton', { name: 'Ширина экрана, пиксели' });
  const height = card.getByRole('spinbutton', { name: 'Высота экрана, пиксели' });
  await expect(dpi).toHaveValue('420');
  await expect(card.getByText('Тёмная тема', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Размер шрифта', { exact: true })).toHaveCount(0);
  await dpi.fill('400');
  await card.getByRole('button', { name: 'Применить плотность', exact: true }).click();
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Плотность: 400 dpi');
  await expect(dpi).toHaveValue('400');
  expect(changes.at(-1)).toEqual({ op: 'display_density', params: { dpi: 400 } });
  await width.fill('720'); await height.fill('1280');
  await card.getByRole('button', { name: 'Применить разрешение', exact: true }).click();
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Экран: 720×1280');
  expect(changes.at(-1)).toEqual({ op: 'display_size', params: { width: 720, height: 1280 } });
  await card.getByRole('button', { name: 'Сбросить разрешение', exact: true }).click();
  await expect(width).toHaveValue('1080'); await expect(height).toHaveValue('1920');
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Разрешение сброшено');
  await card.getByRole('button', { name: 'Сбросить плотность', exact: true }).click();
  await expect(dpi).toHaveValue('420');
  await dpi.fill('999');
  await expect(card.getByRole('button', { name: 'Применить плотность', exact: true })).toBeDisabled();
  await width.fill('');
  await expect(card.getByRole('button', { name: 'Применить разрешение', exact: true })).toBeDisabled();
  const animations = card.getByRole('switch', { name: 'Отключить анимации', exact: true });
  await animations.click();
  await expect(animations).toBeChecked();
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Анимации выключены');
  expect(changes.at(-1)).toEqual({ op: 'animations', params: { enabled: false } });
  await animations.click();
  await expect(page.locator('.notification-success .notification-title')).toHaveText('Анимации включены');
});

test('appearance waits for readback and reports settings that were not applied', async ({ page }) => {
  let pendingRead = false;
  let confirmRead: () => void = () => {};
  const gate = new Promise<void>(resolve => { confirmRead = resolve; });
  await page.route(`**/api/sessions/${sessionId}/env`, async route => {
    if (route.request().method() === 'POST') {
      pendingRead = true;
      return route.fulfill({ json: { result: { applied: true } } });
    }
    if (pendingRead) await gate;
    await route.fulfill({ json: { env: initialEnv } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/#/session/${sessionId}`);
  await page.getByRole('tab', { name: 'Среда', exact: true }).click();
  const card = page.locator('.env-appearance');
  await card.locator('summary').click();
  const touches = card.getByRole('switch', { name: 'Показывать касания', exact: true });
  await touches.click();
  await expect(touches).toBeDisabled();
  await expect(card.getByRole('status')).toHaveText('Применяем…');
  confirmRead();
  await expect(page.locator('.notification-error .notification-message')).toHaveText('Устройство не подтвердило настройку. Попробуйте ещё раз.');
  await expect(touches).not.toBeChecked();
  await expect(touches).toBeEnabled();
});

test('overlapping device reads do not report a false failure and Tab does not change battery', async ({ page }) => {
  const env = structuredClone(initialEnv);
  let holdNextRead = false;
  let heldReadStarted = false;
  let releaseRead: () => void = () => {};
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  const changes: { op: string; params: Record<string, unknown> }[] = [];
  await page.route(`**/api/sessions/${sessionId}/env`, async route => {
    if (route.request().method() === 'POST') {
      const change = route.request().postDataJSON(); changes.push(change);
      if (change.op === 'animations') { env.animations = change.params.enabled; holdNextRead = true; }
      if (change.op === 'battery') env.battery!.charging = change.params.charging;
      return route.fulfill({ json: { result: { applied: true } } });
    }
    if (holdNextRead) {
      holdNextRead = false; heldReadStarted = true;
      const snapshot = structuredClone(env);
      await gate;
      return route.fulfill({ json: { env: snapshot } });
    }
    return route.fulfill({ json: { env } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(`/#/session/${sessionId}`);
  await page.getByRole('group', { name: 'Компоновка сессии' }).getByRole('button', { name: 'Инструменты', exact: true }).click();
  await page.getByRole('tab', { name: 'Среда', exact: true }).click();
  await page.locator('.env-app summary').click();
  await page.locator('.env-appearance summary').click();
  const device = page.locator('.env-card').filter({ has: page.locator('summary strong').filter({ hasText: /^Устройство$/ }) });
  await device.locator('summary').click();
  await device.getByRole('slider').focus();
  await page.keyboard.press('Tab');
  expect(changes).toEqual([]);
  await page.getByRole('switch', { name: 'Отключить анимации' }).click();
  await expect.poll(() => heldReadStarted).toBe(true);
  await device.getByRole('button', { name: 'От USB', exact: true }).click();
  await expect(page.locator('.notification-success')).toContainText('От USB');
  releaseRead();
  await expect(page.locator('.env-appearance')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.notification-error')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Отключить анимации' })).toBeChecked();
  expect(changes.map(item => item.op)).toEqual(['animations', 'battery']);
});
