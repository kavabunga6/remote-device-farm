import { test as base, expect, type Page } from '@playwright/test';
import {
  createContractValidator,
  schemaValidator,
  pathPattern,
} from '../../server/test/support/openapi-contract.mjs';
import { clientOperations, typeSchema } from '../../server/test/support/api-sources.mjs';
const credentials = { username: 'contract-admin', password: 'Synthetic-test-password-42' };
const validate = createContractValidator(),
  compile = schemaValidator({ components: { schemas: {} } });
const clients = clientOperations();
const test = base.extend<{ contracts: () => Promise<void> }>({
  contracts: [
    async ({ page }, use) => {
      const errors: string[] = [],
        pending = new Set<Promise<void>>();
      const inFlight = new Set<import('@playwright/test').Request>();
      const waiters = new Set<() => void>();
      const signal = () => {
        for (const resolve of waiters) resolve();
        waiters.clear();
      };
      page.on('request', (request) => {
        if (
          new URL(request.url()).pathname.startsWith('/api/') &&
          ['fetch', 'xhr'].includes(request.resourceType())
        )
          inFlight.add(request);
      });
      for (const event of ['requestfinished', 'requestfailed'] as const)
        page.on(event, (request) => {
          inFlight.delete(request);
          signal();
        });
      page.on('response', (response) => {
        if (
          !new URL(response.url()).pathname.startsWith('/api/') ||
          !response.headers()['content-type']?.includes('application/json')
        )
          return;
        const task = (async () => {
          const request = response.request(),
            method = request.method(),
            requestUrl = new URL(response.url()),
            routePath = requestUrl.pathname,
            url = routePath + requestUrl.search;
          const body = await response.json();
          let requestBody;
          if (response.ok() && request.headers()['content-type']?.includes('application/json'))
            requestBody = request.postDataJSON();
          const failures = validate({
            method,
            url,
            status: response.status(),
            contentType: response.headers()['content-type'],
            body,
            requestBody,
          });
          if (response.ok())
            for (const c of clients.filter(
              (c) => c.method === method && pathPattern(c.path).test(routePath),
            )) {
              const check = compile(typeSchema(c.responseType, c.checker));
              if (!check(body)) failures.push(`UI response type: ${JSON.stringify(check.errors)}`);
            }
          errors.push(...failures.map((message) => `${method} ${url}: ${message}`));
        })().catch((error) => errors.push(String(error)));
        pending.add(task);
        void task.finally(() => {
          pending.delete(task);
          signal();
        });
      });
      await page.addInitScript(() => localStorage.setItem('rdf.language', 'en'));
      const drain = async () => {
        while (pending.size || inFlight.size) {
          if (pending.size) await Promise.all([...pending]);
          else await new Promise<void>((resolve) => waiters.add(resolve));
        }
      };
      await use(drain);
      await drain();
      expect(
        errors,
        'Actual server responses and UI requests must match OpenAPI and client wire types',
      ).toEqual([]);
    },
    { auto: true },
  ],
});
async function login(page: Page) {
  await page.goto('/');
  expect((await (await page.request.get('/api/config')).json()).authMode).toBe('local');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
}

test('browser login, selected launch resources, environment proxy and asynchronous release use real routes', async ({
  page,
  contracts,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator('.create-settings > summary').click();
  await dialog.getByLabel('Android cores', { exact: true }).fill('1');
  await dialog.getByLabel('Node CPU limit', { exact: true }).fill('3');
  await dialog.getByLabel('Android memory, MB', { exact: true }).fill('1536');
  await dialog.getByLabel('Node memory limit, MB', { exact: true }).fill('3072');
  await dialog.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contract Android', exact: true })).toBeVisible();
  await expect(page.locator('.session-heading')).toContainText('Running');
  const sessions = await (await page.request.get('/api/sessions')).json();
  expect(sessions.sessions).toHaveLength(1);
  expect(sessions.sessions[0].launchOptions).toMatchObject({
    cpu: 3,
    memoryMb: 3072,
    guestCores: 1,
    guestMemoryMb: 1536,
  });
  const id = sessions.sessions[0].id;
  await contracts();
  await page.goto('/#/session/' + id);
  await expect(page.locator('.session-heading')).toContainText('Running');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('tab', { name: 'Environment', exact: true }).click();
  await page
    .locator('.env-card')
    .filter({ has: page.locator('summary strong').filter({ hasText: /^Network$/ }) })
    .locator('summary')
    .click();
  await page.getByLabel('Proxy address', { exact: true }).fill('proxy.example.invalid');
  await page.getByLabel('Port', { exact: true }).fill('8080');
  await page.getByRole('button', { name: 'Set proxy', exact: true }).click();
  await expect(page.locator('.env-proxy')).toContainText('proxy.example.invalid:8080');
  const env = await (await page.request.get(`/api/sessions/${id}/env`)).json();
  expect(env.env.proxy).toEqual({ enabled: true, host: 'proxy.example.invalid', port: 8080 });
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect
    .poll(async () => (await (await page.request.get('/api/sessions')).json()).sessions.length)
    .toBe(0);
});

test('role creation and assignment change both browser navigation and bearer permissions', async ({
  page,
  playwright,
  contracts,
}) => {
  await login(page);
  await contracts();
  await page.goto('/#/admin/roles');
  await page.getByRole('button', { name: 'New role', exact: true }).click();
  await page.getByRole('textbox', { name: 'Role name', exact: true }).fill('Contract observer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.role-list').getByText('Contract observer', { exact: true })).toBeVisible();
  const role = (await (await page.request.get('/api/admin/roles')).json()).roles.find(
    (r: { name: string }) => r.name === 'Contract observer',
  );
  expect(role).toBeTruthy();
  const member = (await (await page.request.get('/api/admin/users')).json()).users.find(
    (u: { username: string }) => u.username === 'contract-member',
  );
  const origin = new URL(page.url()).origin;
  const memberApi = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
  expect(
    (
      await memberApi.post('/api/login', {
        data: { username: 'contract-member', password: 'Synthetic-test-password-43' },
      })
    ).ok(),
  ).toBeTruthy();
  const memberTokenResponse = await memberApi.post('/api/tokens', { data: { name: 'Contract role check' } });
  expect(memberTokenResponse.status()).toBe(201);
  const memberToken = (await memberTokenResponse.json()).token;
  await memberApi.dispose();
  await contracts();
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: 'Assign role · contract-member', exact: true }).click();
  const assignDialog = page.getByRole('dialog');
  await assignDialog.getByRole('combobox', { name: 'Choose a role', exact: true }).selectOption(role.id);
  await assignDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/admin/users')).json()).users.find(
          (u: { id: string }) => u.id === member.id,
        ).roleId,
    )
    .toBe(role.id);
  expect(
    (
      await page.request.get('/api/admin/users', { headers: { authorization: 'Bearer ' + memberToken } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post('/api/sessions', {
        data: { hostId: 'contract-node', profileId: 'contract-profile' },
        headers: { authorization: 'Bearer ' + memberToken, origin },
      })
    ).status(),
  ).toBe(403);
  const adminState = await page.context().storageState();
  await contracts();
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('contract-member');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-test-password-43');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  expect(
    (
      await page.request.post('/api/sessions', {
        data: { hostId: 'contract-node', profileId: 'contract-profile' },
        headers: { origin: new URL(page.url()).origin },
      })
    ).status(),
  ).toBe(403);
  await page.context().addCookies(adminState.cookies);
  await page.request.put(`/api/admin/users/${member.id}/role`, {
    data: { roleId: '00000000-0000-4000-8000-000000000002' },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(
    (
      await page.request.delete('/api/admin/roles/' + role.id, {
        headers: { origin: new URL(page.url()).origin },
      })
    ).ok(),
  ).toBeTruthy();
});

test('logout confirmation cancels safely and invalidates the browser session after acceptance', async ({
  page,
  contracts,
}) => {
  await login(page);
  await contracts();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await page.request.get('/api/sessions')).status()).toBe(200);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/sessions')).status()).toBe(401);
});
