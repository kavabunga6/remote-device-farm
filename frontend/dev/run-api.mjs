import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const unregister = register();
const { apiFixture } = await import('../../server/test/support/api-fixture.ts');
const port = Number(process.env.API_UI_PORT || 5192);
const backend = await apiFixture({ origin: `http://127.0.0.1:${port}` });
delete process.env.VITE_MOCK;
process.env.VITE_API_PROXY = backend.url;
let vite;
let stopping;
const stop = () =>
  (stopping ??= (async () => {
    await vite?.close();
    await backend.close();
    unregister();
  })());
try {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } });
  await vite.listen();
  console.log(`API integration UI listening on http://127.0.0.1:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => void stop().then(() => process.exit(0)));
} catch (error) {
  await stop();
  throw error;
}
