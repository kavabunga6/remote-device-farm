import { normalizePhysicalDevices, normalizeProviderStatuses } from './device-contract.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FarmApi, errorResult, isReleased } from './api.mjs';
import { t } from './messages.mjs';

const id = z.string().uuid();
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/);
const coordinate = z.number().int().min(0).max(8192);
const session = { sessionId: id };
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export function createMcpServer(config, api = new FarmApi(config)) {
  const language = config.language || 'en';
  const text = (key, params) => t(key, params, language);
  const server = new McpServer({ name: 'remote-device-farm', version: '0.1.0' },
    { instructions: text('instructions'), maxToolInputElements: 256 });

  function tool(key, inputSchema, execute, { readOnly = false, idempotent = false } = {}) {
    server.registerTool(key, { title: text(key + '.title'), description: text(key + '.description'), inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly || idempotent, openWorldHint: true } },
      async (params, extra) => {
        try { return await execute(params, extra.signal); }
        catch (error) { return errorResult(error, language); }
      });
  }

  tool('list_profiles', {}, async (_params, signal) => {
    const data = await api.request('GET', '/api/profiles', { signal });
    return json({ profiles: (data.profiles || []).map(profile => fields(profile,
      ['id', 'name', 'androidVersion', 'deviceType', 'abi', 'resolution', 'cpu', 'memoryMb', 'guestMemoryMb', 'guestCores', 'gpuMode'])) });
  }, { readOnly: true });
  tool('list_nodes', {}, async (_params, signal) => {
    const data = await api.request('GET', '/api/hosts', { signal });
    return json({ hosts: (data.hosts || []).map(host => ({
      ...fields(host, ['id', 'name', 'displayName', 'status', 'disabled', 'slots', 'usedSlots', 'lastSeenAt', 'gpuCapabilities']),
      devices: normalizePhysicalDevices(host.devices), providers: normalizeProviderStatuses(host.providers),
    })) });
  }, { readOnly: true });
  tool('list_sessions', {}, async (_params, signal) => {
    const data = await api.request('GET', '/api/sessions', { signal });
    return json({ sessions: data.sessions || [] });
  }, { readOnly: true });
  tool('list_apps', {}, async (_params, signal) => json(await api.request('GET', '/api/apps', { signal })), { readOnly: true });

  tool('request_device', {
    profileId: name, hostId: name.optional(), adbKeyId: id.optional(), label: z.string().max(60).regex(/^[^\x00-\x1f\x7f]*$/).optional(),
    gpuMode: z.enum(['software', 'nvidia']).optional(), leaseTtlSeconds: z.number().int().min(30).max(3600).default(900),
    requestKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  }, async (params, signal) => {
    const { requestKey, ...body } = params;
    const data = await api.request('POST', '/api/queue', { body, signal, idempotencyKey: requestKey });
    return json({ ...data, requestKey });
  }, { idempotent: true });
  tool('get_request', { requestId: id }, async ({ requestId }, signal) => {
    const data = await api.request('GET', '/api/queue/' + requestId, { signal });
    return json({ ...data, released: isReleased(data) });
  }, { readOnly: true });
  tool('get_session', session, async ({ sessionId }, signal) =>
    json(await api.request('GET', '/api/sessions/' + sessionId, { signal })), { readOnly: true });
  tool('renew_device', session, async ({ sessionId }, signal) =>
    json(await api.request('POST', '/api/sessions/' + sessionId + '/keepalive', { body: {}, signal })));
  tool('release_device', { requestId: id }, async ({ requestId }, signal) => json(await api.release(requestId, signal)), { idempotent: true });

  tool('install_app', { ...session, appId: id }, async ({ sessionId, appId }, signal) =>
    json(await api.request('POST', '/api/sessions/' + sessionId + '/apps/install', { body: { appId }, signal, timeoutMs: 240_000 })));
  if (config.uploadRoot) tool('upload_apk', { relativePath: z.string().min(1).max(1000) },
    async ({ relativePath }, signal) => json(await api.upload(relativePath, signal)));

  tool('screenshot', session, async ({ sessionId }, signal) => {
    const image = await api.request('GET', '/api/sessions/' + sessionId + '/screenshot', { signal, binary: true });
    return { content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') },
      { type: 'text', text: text('imageNote') }] };
  }, { readOnly: true });
  tool('device_info', session, async ({ sessionId }, signal) =>
    json(await api.request('GET', '/api/sessions/' + sessionId + '/device-info', { signal, timeoutMs: 60_000 })), { readOnly: true });
  tool('read_logcat', { ...session, lines: z.number().int().min(1).max(500).default(200),
    level: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional(),
    packageName: z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).optional() },
  async ({ sessionId, ...options }, signal) => {
    const query = new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return json(await api.request('GET', '/api/sessions/' + sessionId + '/logcat?' + query, { signal }));
  }, { readOnly: true });

  const actions = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tap'), x: coordinate, y: coordinate }).strict(),
    z.object({ kind: z.literal('swipe'), x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate,
      durationMs: z.number().int().min(50).max(5000).default(300) }).strict(),
    z.object({ kind: z.literal('key'), keyCode: z.number().int().min(1).max(300) }).strict(),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(1000).regex(/^[^\r\n\0]*$/) }).strict(),
  ]);
  tool('device_input', { ...session, action: actions }, async ({ sessionId, action }, signal) =>
    json(await api.request('POST', '/api/sessions/' + sessionId + '/input', { body: action, signal })));
  tool('launch_app', { ...session, packageName: z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/) },
    async ({ sessionId, packageName }, signal) => {
      const result = await api.request('POST', '/api/sessions/' + sessionId + '/adb',
        { body: { argv: ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'] }, signal });
      return result.exitCode === 0 ? json(result) : { ...json(result), isError: true };
    });

  server.registerResource('usage', 'device-farm://usage', { title: text('usage.title'), mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: text('usage.description') }] }));
  return server;
}
