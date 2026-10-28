import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
const defaults = { RDF_URL: 'https://service.example.test', RDF_TOKEN: 'synthetic-config-token' };

test('configuration accepts HTTPS and loopback HTTP and rejects other URL authority or path data', () => {
  for (const url of ['https://service.example.test', 'http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:8080']) {
    assert.equal(loadConfig({ ...defaults, RDF_URL: url }).url, new URL(url).origin);
  }
  for (const url of ['', 'invalid', 'ftp://localhost', 'http://service.example.test', 'https://user@service.example.test',
    'https://user:password@service.example.test', 'https://service.example.test/path', 'https://service.example.test?x=1', 'https://service.example.test#x']) {
    assert.throws(() => loadConfig({ ...defaults, RDF_URL: url }));
  }
  for (const language of ['en', 'ru']) assert.equal(loadConfig({ ...defaults, RDF_MCP_LANGUAGE: language }).language, language);
  assert.throws(() => loadConfig({ ...defaults, RDF_MCP_LANGUAGE: 'unknown' }));
});

test('token files and environment tokens enforce exact byte limits without accepting directories or missing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rdf-mcp-config-'));
  const file = path.join(directory, 'token');
  try {
    const env = { RDF_URL: defaults.RDF_URL, RDF_TOKEN_FILE: file };
    await writeFile(file, '  synthetic-config-token\n');
    assert.equal(loadConfig(env).token, 'synthetic-config-token');
    await writeFile(file, 'x'.repeat(8192));
    assert.equal(loadConfig(env).token.length, 8192);
    assert.equal(loadConfig({ ...defaults, RDF_TOKEN: 'x'.repeat(8192) }).token.length, 8192);
    for (const token of ['', 'x'.repeat(8193), 'two tokens', 'x\ny', 'x\u007fy']) {
      assert.throws(() => loadConfig({ ...defaults, RDF_TOKEN: token }));
    }
    for (const token of ['', 'x'.repeat(8193), ' '.repeat(8193) + 'synthetic-config-token', 'two tokens']) {
      await writeFile(file, token); assert.throws(() => loadConfig(env));
    }
    assert.throws(() => loadConfig({ ...defaults, RDF_TOKEN_FILE: file }));
    assert.throws(() => loadConfig({ ...env, RDF_TOKEN_FILE: directory }));
    assert.throws(() => loadConfig({ ...env, RDF_TOKEN_FILE: path.join(directory, 'missing') }));
    await mkdir(path.join(directory, 'uploads'));
    assert.equal(loadConfig({ ...defaults, RDF_MCP_APK_ROOT: path.join(directory, 'uploads') }).uploadRoot, path.join(directory, 'uploads'));
    assert.throws(() => loadConfig({ ...defaults, RDF_MCP_APK_ROOT: file }));
    assert.throws(() => loadConfig({ ...defaults, RDF_MCP_APK_ROOT: path.join(directory, 'missing') }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
