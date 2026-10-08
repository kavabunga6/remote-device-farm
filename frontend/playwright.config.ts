import { defineConfig, devices } from '@playwright/test';

// The UI runs against the in-memory mock API (frontend/dev), so no backend is needed.
const port = Number(process.env.MOCK_PORT || 5190);

export default defineConfig({
  testDir: './e2e',
  // The mock keeps state in the server process, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: 'node dev/run-mock.mjs',
    env: { MOCK_PORT: String(port) },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
