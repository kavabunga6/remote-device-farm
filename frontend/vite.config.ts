import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async () => {
  const plugins = [react()];
  if (process.env.VITE_MOCK) {
    const moduleUrl = pathToFileURL(resolve(process.cwd(), 'dev/mock-api.mjs')).href;
    const { default: mockApi } = await import(moduleUrl);
    plugins.push(mockApi());
  }
  return {
    plugins,
    server: {
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve(process.cwd(), '../shared')] },
      proxy: {
        '/api': {
          target: process.env.VITE_API_PROXY ?? 'http://localhost:8080',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
