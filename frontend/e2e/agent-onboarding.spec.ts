import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { agentIdForToken } from '../../shared/agent-identity.mjs';
const token = 'rdfagent_synthetic-onboarding-token-not-for-deployment';
const hostId = agentIdForToken(token);
async function setup(page: Page, { language = 'en', theme = 'dark', scale = 1 } = {}) {
  await page.addInitScript(language => localStorage.setItem('rdf.language', language), language);
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontScale: scale, fontFamily: 'system' } } }));
  await page.route('**/api/downloads/agent/info', route => route.fulfill({ json: { version: 'test-1', filename: 'rdf-linux-agent-test-1.tar.gz', sha256: 'a'.repeat(64), sizeBytes: 320000 } }));
  await page.goto('/#/admin/nodes');
  await page.locator('#page-heading-actions').getByRole('button').click();
  await expect(page.locator('.agent-package-row')).toBeVisible();
}

test('download link is public; token setup has no editable node or server fields', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setup(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.locator('a[download]')).toHaveAttribute('href', '/api/downloads/agent');
  await dialog.getByRole('button', { name: 'Copy download link', exact: true }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(new URL('/api/downloads/agent', page.url()).href); expect(link).not.toContain('token=');
  const downloading = page.waitForEvent('download'); await dialog.locator('a[download]').click();
  const download = await downloading; expect(gunzipSync(await readFile((await download.path())!)).toString()).toBe('Demo agent package for UI development only.');
});

test('issuing one token exports two connection values and detects the node after its first connection', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let issued = false, body: unknown = null;
  await page.route('**/api/admin/agents', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { agents: [] } });
    issued = true; body = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { token, agent: { hostId, createdAt: new Date().toISOString() } } });
  });
  await page.route('**/api/hosts', async route => {
    const source = await (await route.fetch()).json();
    return route.fulfill({ json: { hosts: issued ? [{ ...source.hosts[0], id: hostId, name: 'Example node', status: 'online', lastSeenAt: new Date().toISOString() }] : [] } });
  });
  await setup(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create connection token', exact: true }).click();
  await expect(dialog.locator('.agent-config-result')).toBeVisible(); expect(body).toEqual({});
  await expect(dialog.locator('.agent-config-result pre')).not.toContainText(token);
  const downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download .env.agent', exact: true }).click();
  const content = await readFile((await (await downloading).path())!, 'utf8');
  expect(content).toBe(`AGENT_SERVER_URL=${new URL(page.url()).origin}\nAGENT_TOKEN=${token}\nAGENT_SLOTS=1\n`);
  await dialog.getByRole('button', { name: 'Copy token', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await expect(dialog.locator('.agent-connection-check')).toContainText('Node connected');
  await expect(dialog.locator('.agent-connection-check')).toContainText('Example node');
  expect(page.url()).not.toContain(token);
});

test('failed token issuance can retry and an unsaved issued credential warns before closing', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/admin/agents', route => {
    posts++;
    return posts === 1 ? route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } }) : route.fulfill({ status: 201, json: { token, agent: { hostId, createdAt: new Date().toISOString() } } });
  });
  await setup(page); const dialog = page.getByRole('dialog'), create = dialog.getByRole('button', { name: 'Create connection token', exact: true });
  await create.click(); await expect(dialog.locator('.inline-error')).toBeVisible(); await expect(create).toBeEnabled();
  await create.click(); await expect(dialog.locator('.agent-config-result')).toBeVisible(); expect(posts).toBe(2);
  await dialog.locator('.agent-onboarding-header button').click(); await expect(dialog.locator('.agent-close-confirm')).toBeVisible();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click(); await expect(dialog.locator('.agent-config-result')).toBeVisible();
  await page.keyboard.press('Escape'); await dialog.getByRole('button', { name: 'Close without saving', exact: true }).click(); await expect(dialog).toHaveCount(0);
});

for (const [language, theme, width, scale] of [['ru', 'light', 1366, 1], ['en', 'dark', 1440, 1.5], ['de', 'light', 390, 1.3], ['ar', 'dark', 1000, 1.5]] as const) {
  test(`onboarding controls align in ${language} ${theme} at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setup(page, { language, theme, scale });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator('.agent-package-row').evaluate(element => {
      const controls = [...element.querySelectorAll('a,button')].map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
      return { controls, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const [a, b] = geometry.controls; expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1);
    if (Math.abs(a.top - b.top) < 5) expect(Math.abs(a.bottom - b.bottom)).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
    await page.screenshot({ path: `../.tmp-ui/agent-onboarding/${language}-${width}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
