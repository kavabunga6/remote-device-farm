import { openLaunchSection } from './launch-controls';
import { expect, test, type Page } from '@playwright/test';
import type { StartupProgress } from '../src/api';

const profile = { id: 'google-android-30-google-x64', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30, abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis', image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics@sha256:6038625bebef907fded8d53cfc7b98fcbbb37fe8910f4c92030943ed61d9cd8b', cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 4, diskGb: 8, gpuMode: 'software', enabled: true };

async function fixture(page: Page, options: { occupied?: boolean } = {}) {
  const state: { requests: number; session: null | Record<string, unknown> } = { requests: 0, session: null };
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [profile] } }));
  await page.route('**/api/hosts', async route => {
    const response = await route.fetch(); const body = await response.json();
    for (const host of body.hosts) host.usedSlots = options.occupied ? host.slots : 0;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/sessions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessions: state.session ? [state.session] : [] } });
    state.requests++;
    expect(route.request().postDataJSON()).toMatchObject({ profileId: profile.id, gpuMode: 'software' });
    state.session = { id: 'auto-start-qa', ownerId: 'u1', hostId: 'h1', profileId: profile.id, profileName: profile.name, state: 'starting', createdAt: new Date().toISOString(), startupProgress: { stage: 'downloading', currentBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, percent: 50, updatedAt: new Date().toISOString() } satisfies StartupProgress };
    return route.fulfill({ status: 201, json: { session: state.session } });
  });
  await page.route('**/api/sessions/auto-start-qa', route => route.fulfill({ json: { session: state.session } }));
  await page.goto('/');
  await page.getByRole('button', { name: options.occupied ? 'Встать в очередь' : 'Новая сессия', exact: true }).first().click();
  return { state, modal: page.getByRole('dialog') };
}

test('published Docker image reports download, creation and connection without a build stage', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  const { state, modal } = await fixture(page);
  await expect(modal.locator('.create-launch-status')).toContainText('Готов к запуску');
  await expect(modal.getByRole('combobox', { name: 'Устройство', exact: true })).toBeEnabled();
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await modal.locator('#create-tab-device').click();
  await expect(modal.getByRole('switch', { name: 'Ускорение GPU' })).toBeEnabled();
  await expect(modal.locator('#create-gpu-help')).toHaveText('Выключено');
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
  const progress = page.locator('.session-startup-progress');
  await expect(progress).toHaveAttribute('data-stage', 'downloading');
  await expect(progress.locator('.session-startup-percent')).toHaveText('50%');
  await expect(progress).toContainText('512 МиБ из 1 ГиБ');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('value', '50');
  await expect(progress).not.toContainText('Собираем');
  await expect(page.getByRole('button', { name: 'Отменить запуск', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-grid, .workspace-mode-bar, .device-controls, .text-send, .terminal-panel, .session-media')).toHaveCount(0);
  await expect(progress.locator('[aria-current="step"]')).toContainText('Загрузка');
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const cardBox = await progress.boundingBox();
    const layoutBox = await page.locator('.session-layout').boundingBox();
    expect(cardBox!.width).toBeLessThanOrEqual(540);
    expect(Math.abs(cardBox!.x + cardBox!.width / 2 - layoutBox!.x - layoutBox!.width / 2)).toBeLessThan(2);
    const steps = await progress.locator('.session-startup-steps li').all();
    const boxes = await Promise.all(steps.map(step => step.boundingBox()));
    expect(boxes[0]!.x).toBe(boxes[1]!.x);
    expect(boxes[1]!.x).toBe(boxes[2]!.x);
    expect(boxes[0]!.y + boxes[0]!.height).toBeLessThanOrEqual(boxes[1]!.y);
    expect(boxes[1]!.y + boxes[1]!.height).toBeLessThanOrEqual(boxes[2]!.y);
    expect(cardBox!.y + cardBox!.height).toBeLessThan(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('docker-download-' + viewport.width + '-dark.png'), fullPage: true });
  }
  state.session!.startupProgress = { stage: 'creating', updatedAt: new Date().toISOString() };
  await expect(progress).toHaveAttribute('data-stage', 'creating');
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('value');
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(progress.locator('.session-startup-steps li').nth(0)).toContainText('Выполнено');
  await expect(progress.locator('.session-startup-steps li').nth(1)).toContainText('Создаём устройство');
  await expect(progress.locator('.session-startup-steps li').nth(2)).toContainText('Ожидает');
  const segment = progress.locator('.session-startup-indeterminate>span');
  await expect(segment).toBeVisible();
  expect(await segment.evaluate(node => getComputedStyle(node).animationName)).toBe('session-startup-pending');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await segment.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(progress.locator('[aria-current="step"]')).toContainText('Создание');
  await expect(progress).not.toContainText('50%');
  await expect(progress).not.toContainText('512 МиБ');
  state.session!.startupProgress = { stage: 'booting' };
  await expect(progress.locator('[aria-current="step"]')).toContainText('Загружаем Android');
  state.session!.startupProgress = { stage: 'ready', percent: 100 };
  await expect(progress.locator('[aria-current="step"]')).toContainText('Подключаем экран');
  await expect(progress.locator('.is-complete')).toHaveCount(2);
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('value');
  await expect(progress).not.toContainText('100%');
  state.session!.state = 'running';
  await expect(progress).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.device-controls')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст для устройства', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-panel')).toBeVisible();
  await expect.poll(async () => (await page.locator('.device-screen').boundingBox())?.height || 0).toBeGreaterThan(200);
  expect(state.requests).toBe(1);
});

test('published Docker images can join the queue when all slots are occupied', async ({ page }) => {
  let queued = 0;
  await page.route('**/api/queue', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { entries: [], maxEntries: 3 } });
    queued++;
    expect(route.request().postDataJSON()).toMatchObject({ profileId: profile.id, gpuMode: 'software' });
    return route.fulfill({ status: 201, json: { id: 'auto-queue-qa', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  });
  const { state, modal } = await fixture(page, { occupied: true });
  await expect(modal.getByRole('button', { name: 'Встать в очередь', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Встать в очередь', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(queued).toBe(1);
  expect(state.requests).toBe(0);
});
