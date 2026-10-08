// Starts the Vite dev server with the mock API enabled (no backend needed).
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

process.env.VITE_MOCK = '1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: Number(process.env.MOCK_PORT || 5173), host: '127.0.0.1' } });
await server.listen();
server.printUrls();
