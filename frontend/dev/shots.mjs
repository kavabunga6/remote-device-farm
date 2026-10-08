// Screenshot matrix for visual review: node dev/shots.mjs <hash-route> <out-dir> [--click "Button text"] [--tab "Tab text"] [--only dark|light] [--width 390] [--empty-overview]
// Needs the mock server running: MOCK_PORT=<port> node dev/run-mock.mjs (same MOCK_PORT is read here).
// Prints horizontal overflow and browser errors; writes viewport and full-page PNGs for each size and theme.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const route = args[0] || '#/overview';
const out = args[1] || 'coverage/visual-review';
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(process.env.MOCK_PORT || 5173);
const sizes = [[390, 844], [1366, 768], [1920, 1080], [2560, 1440]];
const only = opt('--only');
const onlyWidth = opt('--width') ? Number(opt('--width')) : null;
const themes = only ? [only] : ['light', 'dark'];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    for (const [width, height] of sizes) {
      if (onlyWidth && onlyWidth !== width) continue;
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'ru-RU' });
      const page = await context.newPage();
      if (args.includes('--empty-overview')) {
        const empty = new Map([
          ['/api/sessions', { sessions: [] }],
          ['/api/queue', { entries: [], maxEntries: 3 }],
          ['/api/shares/mine', { shares: [] }],
          ['/api/teams/mine', { teams: [] }],
          ['/api/me/notifications', { notifications: [] }],
        ]);
        await page.route('**/api/**', route => {
          const path = new URL(route.request().url()).pathname;
          const body = route.request().method() === 'GET' ? empty.get(path) : undefined;
          return body ? route.fulfill({ json: body }) : route.continue();
        });
      }
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/${route}`);
      await page.waitForSelector('#root *', { timeout: 15000 });
      await page.waitForTimeout(1800);
      const click = opt('--click');
      if (click) { await page.getByRole('button', { name: click }).first().click(); await page.waitForTimeout(600); }
      const tab = opt('--tab');
      if (tab) { await page.getByRole('tab', { name: tab }).first().click(); await page.waitForTimeout(900); }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const file = join(out, `${theme}-${width}x${height}.png`);
      const full = join(out, `${theme}-${width}x${height}-full.png`);
      await page.screenshot({ path: file });
      await page.screenshot({ path: full, fullPage: true });
      console.log(`${theme} ${width}x${height}: overflow=${overflow}px, pageErrors=${errors.length} -> ${file}, ${full}`);
      for (const error of errors) console.error(`  ${error}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
