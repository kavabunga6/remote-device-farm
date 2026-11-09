import { openLaunchSection } from './launch-controls';
import { test, expect, type Page } from '@playwright/test';
const profile = { id: 'launch-qa', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30,
  abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis', image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',
  cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 8, diskMaxGb: 128, sdcardGb: 0, sdcardMaxGb: 32, gpuMode: 'software', enabled: true, emulatorParams: '-no-snapshot' };
async function fixture(page: Page, occupied = false) {
  const state = { requests: [] as Record<string, unknown>[], privilegedAllowed: false };
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [profile] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/adb-public-keys', route => route.fulfill({ json: { keys: [{ id: 'selected-key', name: 'Мой ноутбук', fingerprint: 'fingerprint', createdAt: new Date().toISOString() }] } }));
  await page.route('**/api/me/adb-key', route => route.fulfill({ json: { key: null } }));
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    for (const host of body.hosts) {
      host.usedSlots = occupied ? host.slots : 0;
      host.lastSeenAt = new Date().toISOString();
      host.metrics = { ...host.metrics, privilegedEmulatorsAllowed: state.privilegedAllowed };
    }
    await route.fulfill({ json: body });
  });
  for (const path of ['sessions', 'queue']) await page.route('**/api/' + path, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: path === 'sessions' ? { sessions: [] } : { entries: [], maxEntries: 3 } });
    state.requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: { code: 'invalid_launch_options', message: 'Invalid launch options in test' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: occupied ? 'Встать в очередь' : 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await openLaunchSection(modal, 'storage');
  await expect(modal.getByRole('combobox', { name: 'Ключ ADB', exact: true })).toBeEnabled();
  return state;
}
for (const occupied of [false, true]) test(`launch options and chosen ADB key reach ${occupied ? 'queue' : 'direct session'} API`, async ({ page }) => {
  const state = await fixture(page, occupied), modal = page.getByRole('dialog');
  await modal.getByLabel('Раздел данных, ГБ', { exact: true }).fill('24');
  await modal.getByLabel('SD-карта, ГБ', { exact: true }).fill('4');
  await modal.getByRole('combobox', { name: 'Ключ ADB', exact: true }).selectOption('selected-key');
  await modal.locator('.create-advanced-settings > summary').click();
  const args = modal.getByLabel('Аргументы эмулятора', { exact: true });
  const launch = modal.getByRole('button', { name: occupied ? 'Встать в очередь' : 'Запустить', exact: true });
  await args.fill('-no-boot-anim, -no-snapshot');
  await expect(args).toHaveAttribute('aria-invalid', 'true');
  await expect(modal.locator('#launch-params-error')).toContainText('Замените запятые');
  await expect(launch).toBeDisabled();
  expect(state.requests).toHaveLength(0);
  await args.fill('-no-boot-anim\n-no-snapshot');
  await expect(args).toHaveAttribute('aria-invalid', 'false');
  await launch.click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0]).toMatchObject({ profileId: profile.id, adbKeyId: 'selected-key', gpuMode: 'software', launchOptions: { diskGb: 24, sdCardMb: 4096, emulatorParams: '-no-boot-anim -no-snapshot' } });
  await expect(modal.locator('.create-error')).toContainText('Проверьте размеры хранилища');
});
test('invalid storage keeps the reason visible when the settings section is closed', async ({ page }) => {
  await fixture(page);
  const modal = page.getByRole('dialog');
  const card = modal.getByLabel('SD-карта, ГБ', { exact: true });
  const launch = modal.getByRole('button', { name: 'Запустить', exact: true });
  await card.fill('0.01');
  await expect(card).toHaveAttribute('aria-invalid', 'true');
  const diskBox = await modal.getByLabel('Раздел данных, ГБ', { exact: true }).boundingBox();
  const cardBox = await card.boundingBox();
  expect(Math.abs(diskBox!.y - cardBox!.y)).toBeLessThanOrEqual(1);
  await expect(launch).toBeDisabled();
  await modal.locator('.create-storage-section > summary').click();
  await expect(modal.locator('.create-launch-status')).toContainText('0,125');
  await openLaunchSection(modal, 'storage');
  await card.fill('0.125');
  await expect(launch).toBeEnabled();
});
test('privileged launch explains the node restriction from the settings tab', async ({ page }, testInfo) => {
  await page.clock.install();
  const state = await fixture(page);
  const modal = page.getByRole('dialog');
  await modal.locator('.create-advanced-settings > summary').click();
  const privileged = modal.getByRole('switch', { name: 'Privileged-контейнер', exact: true });
  const launch = modal.getByRole('button', { name: 'Запустить', exact: true });
  await expect(privileged).toBeDisabled();
  await expect(privileged).toHaveAccessibleDescription('Privileged-режим не разрешён на узле.');
  state.privilegedAllowed = true;
  await page.clock.fastForward(10_000);
  await expect(privileged).toBeEnabled();
  await privileged.check();
  await expect(launch).toBeEnabled();
  state.privilegedAllowed = false;
  await page.clock.fastForward(10_000);
  await expect(launch).toBeDisabled();
  const footer = modal.locator('.create-launch-status');
  await expect(footer).toContainText('Privileged-режим не разрешён на узле');
  await expect(privileged).toHaveAccessibleDescription(/Выключите Privileged-режим/);
  const endGap = await privileged.evaluate(input => input.parentElement!.getBoundingClientRect().right - input.getBoundingClientRect().right);
  expect(Math.abs(endGap)).toBeLessThanOrEqual(1);
  await privileged.scrollIntoViewIfNeeded();
  await modal.screenshot({ path: testInfo.outputPath('privileged-blocker.png') });
  await footer.getByRole('button', { name: 'Что мешает запуску' }).click();
  await expect(modal.locator('#create-tab-device')).toBeFocused();
  await expect(modal.getByRole('region', { name: 'Проверка запуска', exact: true })).toContainText('Выключите Privileged-режим');
  await modal.locator('#create-tab-settings').click();
  await privileged.uncheck();
  await expect(launch).toBeEnabled();
});
test('desktop dialog aligns fields and keeps launch action in view', async ({ page }, testInfo) => {
  await fixture(page); const modal = page.getByRole('dialog');
  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    const box = await modal.boundingBox(), button = await modal.getByRole('button', { name: 'Запустить', exact: true }).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1180); expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThan(size.height);
    expect(await modal.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const disk = await modal.getByLabel('Раздел данных, ГБ', { exact: true }).boundingBox(), sd = await modal.getByLabel('SD-карта, ГБ', { exact: true }).boundingBox();
    expect(Math.abs(disk!.y - sd!.y)).toBeLessThan(1); expect(Math.abs(disk!.width - sd!.width)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath(`launch-${size.width}.png`), fullPage: true });
  }
});


test('reset is a button enabled only for changed resources, storage or arguments', async ({ page }) => {
  await fixture(page);
  const modal = page.getByRole('dialog');
  const reset = modal.getByRole('button', { name: 'Сбросить', exact: true });
  const cpu = modal.getByLabel('CPU контейнера', { exact: true });
  const disk = modal.getByLabel('Раздел данных, ГБ', { exact: true });
  await expect(reset).toHaveClass(/button outline/);
  await expect(modal.locator('.create-session-footer .create-reset')).toBeVisible();
  await expect(modal.locator('.create-session-body .create-reset')).toHaveCount(0);
  await expect(reset).toBeDisabled();
  await cpu.fill('2');
  await expect(reset).toBeEnabled();
  await cpu.fill(String(profile.cpu));
  await expect(reset).toBeDisabled();
  await disk.fill('24');
  await expect(reset).toBeEnabled();
  await disk.fill(String(profile.diskGb));
  await expect(reset).toBeDisabled();
  await modal.locator('.create-advanced-settings > summary').click();
  const args = modal.getByLabel('Аргументы эмулятора', { exact: true });
  await args.fill('  -no-snapshot  ');
  await expect(reset).toBeDisabled();
  await args.fill('-no-boot-anim');
  await expect(reset).toBeEnabled();
  await cpu.fill('2');
  await disk.fill('24');
  await reset.click();
  await expect(cpu).toHaveValue(String(profile.cpu));
  await expect(disk).toHaveValue(String(profile.diskGb));
  await expect(args).toHaveValue(profile.emulatorParams);
  await expect(reset).toBeDisabled();
});

test('launch tabs preserve drafts and ADB selection with keyboard navigation', async ({ page }) => {
  const state = await fixture(page), modal = page.getByRole('dialog');
  const cpu = modal.getByLabel('CPU контейнера', { exact: true });
  const disk = modal.getByLabel('Раздел данных, ГБ', { exact: true });
  const adb = modal.getByRole('combobox', { name: 'Ключ ADB', exact: true });
  await cpu.fill('3');
  await disk.fill('24');
  await adb.selectOption('selected-key');
  const options = modal.getByRole('tab', { name: 'Параметры запуска', exact: true });
  await options.focus();
  await page.keyboard.press('Home');
  await expect(modal.getByRole('tab', { name: 'Устройство', exact: true })).toBeFocused();
  await expect(modal.getByRole('tabpanel', { name: 'Устройство', exact: true })).toBeVisible();
  await expect(cpu).toBeHidden();
  await modal.getByRole('switch', { name: 'Ускорение GPU' }).check();
  await modal.getByRole('tab', { name: 'Устройство', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(options).toBeFocused();
  await expect(options).toHaveAttribute('aria-selected', 'true');
  await expect(cpu).toHaveValue('3');
  await expect(disk).toHaveValue('24');
  await expect(adb).toHaveValue('selected-key');
  await expect(modal.locator('.create-connection-section')).toHaveAttribute('open');
  const motion = await modal.locator('#create-panel-settings').evaluate(element => getComputedStyle(element).transitionDuration);
  expect(motion).toBe('0s');
  await page.keyboard.press('ArrowLeft');
  await expect(modal.locator('#create-tab-device')).toBeFocused();
  await page.keyboard.press('End');
  await expect(options).toBeFocused();
  await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0]).toMatchObject({ adbKeyId: 'selected-key', gpuMode: 'nvidia', launchOptions: { cpu: 3, diskGb: 24 } });
});

test('hidden tab controls are skipped by the dialog focus cycle', async ({ page }) => {
  await fixture(page); const modal = page.getByRole('dialog');
  await modal.locator('#create-tab-device').click();
  const settings = modal.locator('#create-panel-settings');
  const seen: string[] = [];
  await modal.locator('#create-tab-device').focus();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    const location = await modal.evaluate(element => {
      const active = document.activeElement;
      return { within: element.contains(active), hidden: Boolean(active?.closest('[hidden]')), id: active?.id || active?.tagName || '' };
    });
    expect(location.within).toBe(true);
    expect(location.hidden).toBe(false);
    seen.push(location.id);
  }
  await expect(settings).toBeHidden();
  expect(seen).toContain('create-tab-device');
});
