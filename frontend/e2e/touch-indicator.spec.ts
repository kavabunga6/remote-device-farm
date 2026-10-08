import { expect, test } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';

test('viewer reads touch preference on open and follows a mouse drag in the screenshot fallback', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  let showTouches = true;
  let reads = 0;
  const updates: unknown[] = [];
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + sessionId + '/env', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      updates.push(body);
      if (body.op === 'show_touches') showTouches = body.params.enabled;
      await route.fulfill({ json: { result: { op: body.op, applied: true } } });
    } else {
      reads++;
      await route.fulfill({ json: { env: {
        darkMode: 'no', fontScale: 1, animations: true, showTouches, pointerLocation: false, timezone: 'Europe/Moscow',
        size: { physical: '720x1280', override: null }, density: { physical: 320, override: null },
        battery: { level: 100, charging: 'ac' },
      } } });
    }
  });
  await page.goto('/#/session/' + sessionId);
  await expect.poll(() => reads).toBe(1);
  await expect(page.locator('.device-screen img')).toHaveClass('active-frame');
  const touch = page.getByRole('application', { name: 'Сенсорный экран устройства' });
  const marker = touch.locator('.session-touch-marker');
  await expect(marker).toBeHidden();
  const bounds = await touch.boundingBox();
  expect(bounds).not.toBeNull();
  const first = { x: bounds!.x + bounds!.width * .25, y: bounds!.y + bounds!.height * .3 };
  const last = { x: bounds!.x + bounds!.width * .7, y: bounds!.y + bounds!.height * .6 };
  await page.mouse.move(first.x, first.y); await page.mouse.down();
  await expect(marker).toBeVisible();
  expect(await marker.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect.poll(() => marker.evaluate(element => parseFloat(element.style.left))).toBeCloseTo(25, 0);
  await page.mouse.move(last.x, last.y, { steps: 4 });
  await expect.poll(() => marker.evaluate(element => parseFloat(element.style.left))).toBeCloseTo(70, 0);
  await expect.poll(() => marker.evaluate(element => parseFloat(element.style.top))).toBeCloseTo(60, 0);
  await page.mouse.up(); await expect(marker).toBeHidden();

  await page.mouse.down(); await expect(marker).toBeVisible();
  await touch.dispatchEvent('lostpointercapture', { pointerId: 1 });
  await expect(marker).toBeHidden(); await page.mouse.up();

  await page.getByRole('tab', { name: 'Среда', exact: true }).click();
  await page.locator('.env-appearance summary').click();
  const toggle = page.getByRole('switch', { name: 'Показывать касания', exact: true });
  await expect(toggle).toBeChecked(); await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(updates).toEqual([{ op: 'show_touches', params: { enabled: false } }]);
  const nextBounds = await touch.boundingBox();
  await page.mouse.move(nextBounds!.x + nextBounds!.width / 2, nextBounds!.y + nextBounds!.height / 2);
  await page.mouse.down(); await expect(marker).toBeHidden(); await page.mouse.up();
});
