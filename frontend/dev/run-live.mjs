import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { liveProxy } from './live-proxy.mjs';

const args = process.argv.slice(2);
const target = args.find(arg => !arg.startsWith('--')) || process.env.VITE_API_PROXY;
if (!target) {
  console.error('Usage: npm run dev:live -- https://farm.example:8443 [--insecure]');
  process.exit(1);
}
if (args.some(arg => arg.startsWith('--') && arg !== '--insecure')) throw new Error('Unknown option');
const port = Number(process.env.DEV_PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DEV_PORT');
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = `http://localhost:${port}`;
// The live runner always uses the real API, even after a mock development session.
delete process.env.VITE_MOCK;
const { plugin, proxy } = liveProxy({ target, origin, insecure: args.includes('--insecure') });
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [plugin],
  server: { host: 'localhost', port, strictPort: true, proxy: { '/api': proxy } },
});
await server.listen();
console.log(`Live UI: ${origin} (API: ${new URL(target).origin})`);
server.printUrls();
