import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const variant of [{ width: 1440, theme: 'light', scale: 1 }, { width: 1440, theme: 'dark', scale: 1.25 }, { width: 390, theme: 'light', scale: 1 }, { width: 390, theme: 'dark', scale: 1.5 }]) {
  test('device proxy applies and resets with aligned fields at '+variant.width+' '+variant.theme, async ({ page }) => {
    const changes: any[] = [];
    let proxy = { enabled: false, host: '', port: 0 };
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: variant.theme, fontFamily: 'system', fontScale: variant.scale, defaultAdbKeyId: null } } }));
    await page.setViewportSize({ width: variant.width, height: 1000 });
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/sessions/'+sessionId+'/env', async route => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch(); const data = await response.json();
        return route.fulfill({ response, json: { env: { ...data.env, proxy } } });
      }
      const change = route.request().postDataJSON(); changes.push(change);
      proxy = change.params.reset ? { enabled: false, host: '', port: 0 } : { enabled: true, ...change.params };
      await route.fulfill({ json: { result: { applied: true } } });
    });
    await page.goto('/#/session/'+sessionId);
    await page.getByRole('group', { name: 'Компоновка сессии' }).getByRole('button', { name: 'Инструменты', exact: true }).click();
    await page.getByRole('tab', { name: 'Среда', exact: true }).click();
    await page.locator('.env-card').filter({ has: page.locator('summary strong').filter({ hasText: /^Сеть$/ }) }).locator('summary').click();
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', variant.theme);
    const section = page.getByRole('region', { name: 'HTTP-прокси устройства' });
    const host = section.getByLabel('Адрес прокси', { exact: true }), port = section.getByLabel('Порт', { exact: true });
    await expect(host).toBeEnabled();
    await host.fill('http://invalid');
    await expect(section.getByRole('button', { name: 'Установить прокси' })).toBeDisabled();
    await expect(host).toHaveAttribute('aria-invalid', 'true');
    await host.fill('Proxy.example'); await port.fill('3128');
    await page.evaluate(() => document.fonts.ready);
    const sizes = await section.locator('input').evaluateAll(inputs => inputs.map(input => { const r=input.getBoundingClientRect(); return { top:r.top,bottom:r.bottom,left:r.left }; }));
    if (sizes[0]!.left !== sizes[1]!.left) {
      expect(Math.abs(sizes[0]!.top-sizes[1]!.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(sizes[0]!.bottom-sizes[1]!.bottom)).toBeLessThanOrEqual(1);
    }
    await section.getByRole('button', { name: 'Установить прокси' }).click();
    await expect(section.locator('.env-proxy-state')).toContainText('Прокси включёнproxy.example:3128');
    await expect(page.getByRole('tab', { name: 'Логкат', exact: true })).not.toContainText(/99|Ошиб/);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp-ui/device-proxy/proxy-'+variant.width+'-'+variant.theme+'.png', import.meta.url)) });
    await section.getByRole('button', { name: 'Выключить прокси' }).click();
    await expect(section.locator('.env-proxy-state')).toContainText('Прокси выключен');
    expect(changes).toEqual([{ op: 'proxy', params: { host: 'proxy.example', port: 3128 } }, { op: 'proxy', params: { reset: true } }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  });
}
