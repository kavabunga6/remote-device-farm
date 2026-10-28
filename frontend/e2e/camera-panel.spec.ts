import { expect, test } from '@playwright/test';
const id = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const variant of [
  { language: 'ru', theme: 'light', scale: 1, width: 1440 },
  { language: 'en', theme: 'dark', scale: 1.5, width: 1440 },
  { language: 'ru', theme: 'dark', scale: 1, width: 768 },
]) test('virtual camera upload, state, reset and alignment ' + JSON.stringify(variant), async ({ page }, info) => {
  const actions: string[] = [];
  let imageSet = false;
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), variant.language);
  await page.setViewportSize({ width: variant.width, height: 1100 });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + id + '/camera**', async route => {
    const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1)!;
    if (request.method() === 'POST') {
      actions.push(action);
      if (action === 'image') {
        expect(request.headers()['content-type']).toContain('multipart/form-data');
        expect(request.postDataBuffer()!.includes(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true);
        imageSet = true;
      } else if (action === 'reset') imageSet = false;
    }
    await route.fulfill({ json: { available: true, imageSet } });
  });
  await page.goto('/#/session/' + id);
  if (variant.width < 1700) await page.getByRole('group', { name: /Компоновка сессии|Session layout/ }).getByRole('button', { name: /^(Инструменты|Tools)$/ }).click();
  await page.locator('#tool-tab-env').click();
  const camera = page.locator('.env-camera');
  await camera.locator('summary').click();
  await expect(camera.locator('input')).toBeEnabled();
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 200;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#000'; ctx.fillRect(20, 20, 60, 60); ctx.fillRect(120, 20, 60, 60); ctx.fillRect(20, 120, 60, 60);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await camera.locator('input').setInputFiles({ name: 'test-pattern.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(camera.locator('.env-camera-state')).toHaveAttribute('data-active', 'true');
  const buttons = camera.locator('.env-camera-actions button[data-camera-action]');
  await expect(buttons.first()).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  const bounds = await buttons.evaluateAll(items => items.map(item => { const b = item.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }));
  if (Math.abs(bounds[0]!.top - bounds[1]!.top) < 5) {
    expect(Math.abs(bounds[0]!.top - bounds[1]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds[0]!.bottom - bounds[1]!.bottom)).toBeLessThanOrEqual(1);
  }
  await camera.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('camera.png') });
  await buttons.first().click();
  await expect.poll(() => actions).toContain('show');
  await buttons.last().click();
  await expect(camera.locator('.env-camera-state')).toHaveAttribute('data-active', 'false');
  expect(actions).toEqual(['image', 'show', 'reset']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
