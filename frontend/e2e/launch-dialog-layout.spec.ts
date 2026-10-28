import { expect, test } from '@playwright/test';

for (const [name, theme, width, height, scale, language] of [
  ['dark', 'dark', 1440, 1000, 1, 'ru'], ['light', 'light', 1440, 1000, 1, 'ru'],
  ['laptop', 'dark', 1366, 768, 1, 'en'], ['large-german', 'light', 1280, 1000, 1.5, 'de'],
  ['arabic', 'dark', 1440, 1000, 1, 'ar'], ['narrow', 'light', 390, 844, 1, 'ru'],
] as const) {
  test('launch dialog hierarchy and progressive options in ' + name, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [{
      id: 'android-16', name: 'Android 16 · Google APIs (API 36.1)', androidVersion: '16', apiLevel: 36,
      abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis', image: 'registry.example/emulator:36.1',
      cpu: 8, memoryMb: 6144, guestCores: 6, guestMemoryMb: 4096, enabled: true,
      diskGb: 8, diskMaxGb: 64, sdcardGb: 0, sdcardMaxGb: 16, launchOverridesAllowed: true,
      deviceModel: 'Pixel', resolution: '1080x2400', emulatorParams: '-no-snapshot',
    }] } }));
    await page.addInitScript(value => localStorage.setItem('rdf.language', value), language);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
      theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null,
    } } }));
    await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [] } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/hosts', async route => {
      const result = await (await route.fetch()).json();
      for (const host of result.hosts) Object.assign(host, { slotCpu: 8, slotMemoryMb: 8192, usedSlots: 0, lastSeenAt: new Date().toISOString() });
      await route.fulfill({ json: result });
    });
    await page.goto('/');
    await page.locator('.page-heading button.primary').first().click();
    const dialog = page.getByRole('dialog');
    const gpu = dialog.locator('.create-gpu-launch-setting input');
    await expect(gpu).toBeEnabled();
    await expect(dialog.locator('.create-launch-status')).toHaveAttribute('data-state', 'ready');
    await expect(dialog.locator('button[type=submit]')).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await expect(dialog.locator('.create-selected-profile h3')).toHaveCount(0);
    await expect(dialog.locator('.create-summary-resources')).toBeVisible();
    await expect(dialog.locator('.create-settings')).not.toHaveAttribute('open');
    if (scale === 1 && width >= 1000) {
      const size = await dialog.boundingBox();
      expect(size!.width).toBeLessThanOrEqual(641);
      expect(size!.height).toBeLessThanOrEqual(600);
    }
    await page.screenshot({ path: testInfo.outputPath('launch-' + name + '.png'), fullPage: false, animations: 'disabled' });
    await gpu.check();
    await expect(dialog.locator('.create-gpu-launch-setting')).toHaveAttribute('data-enabled', 'true');
    const onState = await dialog.evaluate(element => {
      const panel = getComputedStyle(element.querySelector('.create-gpu-launch-setting')!);
      const toggle = getComputedStyle(element.querySelector('.create-gpu-launch-setting input')!);
      const resolution = element.querySelector('.create-profile-meta [title] bdi[dir=ltr]')!;
      const capacity = element.querySelector('.create-summary-resources>div:last-child dd>bdi')!;
      return { border: panel.borderColor, track: toggle.backgroundColor, resolution: getComputedStyle(resolution).direction, capacity: getComputedStyle(capacity).direction };
    });
    expect(onState.border).toBe(onState.track);
    expect(onState.resolution).toBe('ltr');
    expect(onState.capacity).toBe('ltr');
    if (name === 'dark' || name === 'light') await dialog.screenshot({ path: testInfo.outputPath('dialog-' + name + '.png'), animations: 'disabled' });
    if (name === 'dark' || name === 'light') await page.screenshot({ path: testInfo.outputPath('launch-gpu-' + name + '.png'), fullPage: false, animations: 'disabled' });
    await dialog.locator('.create-settings > summary').click();
    await expect(dialog.locator('.create-summary-resources')).toBeHidden();
    await expect(dialog.locator('.create-resource-fields input')).toHaveCount(4);
    await expect(dialog.locator('.create-storage-section')).not.toHaveAttribute('open');
    await expect(dialog.locator('.create-connection-section')).not.toHaveAttribute('open');
    const headings = await dialog.evaluate(element => [...element.querySelectorAll(
      '.create-device-field>span,.create-summary-resources dt,.create-gpu-switch strong,.create-settings>summary,.create-setting-group>summary,.create-container-details>summary,.create-settings-section h4,.create-resource-fields h5,.create-advanced-settings>summary'
    )].map(heading => {
      const style = getComputedStyle(heading);
      return { size: style.fontSize, weight: style.fontWeight, color: style.color, opacity: style.opacity };
    }));
    for (const heading of headings) expect(heading).toEqual(headings[0]);
    const geometry = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('.create-resource-fields input')].map(input => {
        const r = input.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
      });
      const columns = getComputedStyle(element.querySelector('.create-resource-fields')!).gridTemplateColumns.split(' ').length;
      const differences = columns === 2 ? [0, 2].flatMap(index => [
        Math.abs(controls[index].top - controls[index + 1].top),
        Math.abs(controls[index].bottom - controls[index + 1].bottom),
      ]) : [];
      const footer = element.querySelector('.create-session-footer')!.getBoundingClientRect();
      return { left: box.left, right: box.right, overflow: element.scrollWidth - element.clientWidth, differences, footerBottom: footer.bottom };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.footerBottom).toBeLessThanOrEqual(height);
    for (const delta of geometry.differences) expect(delta).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('launch-options-' + name + '.png'), fullPage: false, animations: 'disabled' });
  });
}


test('ADB load failure reveals connection settings and allows a keyboard retry', async ({ page }) => {
  let failKeys = true;
  await page.route('**/api/me/adb-public-keys', route => route.fulfill(failKeys
    ? { status: 503, json: { error: { code: 'unavailable', message: 'Unavailable' } } }
    : { json: { keys: [] } }));
  await page.goto('/');
  await page.locator('.page-heading button.primary').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.create-connection-section .inline-warning')).toBeVisible();
  await expect(dialog.locator('.create-settings')).toHaveAttribute('open');
  await expect(dialog.locator('.create-connection-section')).toHaveAttribute('open');
  failKeys = false;
  const retry = dialog.locator('.inline-warning button');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.inline-warning')).toHaveCount(0);
  await expect(dialog.locator('.create-adb-select select')).toBeEnabled();
  const summary = dialog.locator('.create-connection-section > summary');
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(dialog.locator('.create-adb-select select')).toBeHidden();
});
