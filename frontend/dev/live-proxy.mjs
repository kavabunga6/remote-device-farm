// This module is only loaded by the local development runner.
export function liveProxy({ target, origin, insecure = false }) {
  const upstream = new URL(target);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('API target must be an HTTP(S) origin without credentials or path');
  }
  const local = new URL(origin);
  const allowedHosts = new Set([local.host, `127.0.0.1:${local.port}`, `[::1]:${local.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map(host => `${local.protocol}//${host}`));
  const isApi = req => req.url === '/api' || req.url?.startsWith('/api/') || req.url?.startsWith('/api?');
  const isLocal = req => {
    if (!allowedHosts.has(req.headers.host)) return false;
    const source = req.headers.origin || req.headers.referer;
    if (!source) return !req.headers.cookie || !!req.headers.authorization;
    try { return allowedOrigins.has(new URL(source).origin); } catch { return false; }
  };
  const forwardOrigin = (proxyReq, req) => {
    if (!isLocal(req)) { proxyReq.destroy(); return; }
    proxyReq.setHeader('origin', upstream.origin);
    if (req.headers.referer) proxyReq.setHeader('referer', `${upstream.origin}/`);
  };
  return {
    plugin: {
      name: 'local-live-api-boundary',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!isApi(req) || isLocal(req)) return next();
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Local development origin required');
        });
        server.httpServer?.prependListener('upgrade', (req, socket) => {
          if (isApi(req) && !isLocal(req)) socket.destroy();
        });
      },
    },
    proxy: {
      target: upstream.origin,
      changeOrigin: true,
      ws: true,
      secure: !insecure,
      configure(proxy) {
        proxy.on('proxyReq', forwardOrigin);
        proxy.on('proxyReqWs', forwardOrigin);
      },
    },
  };
}
