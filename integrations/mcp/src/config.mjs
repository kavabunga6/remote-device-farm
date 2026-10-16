import { readFileSync, realpathSync, statSync } from 'node:fs';
import { t } from './messages.mjs';

export function loadConfig(env = process.env) {
  const language = env.RDF_MCP_LANGUAGE || 'en';
  if (!['en', 'ru'].includes(language)) throw new Error(t('config', {}, 'en'));
  let url;
  try { url = new URL(env.RDF_URL); } catch { throw new Error(t('url', {}, language)); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(t('url', {}, language));
  }
  let token = env.RDF_TOKEN;
  if (token && env.RDF_TOKEN_FILE) throw new Error(t('token', {}, language));
  if (env.RDF_TOKEN_FILE) {
    try {
      const stat = statSync(env.RDF_TOKEN_FILE);
      if (!stat.isFile() || stat.size > 8192) throw new Error();
      token = readFileSync(env.RDF_TOKEN_FILE, 'utf8').trim();
    } catch { throw new Error(t('token', {}, language)); }
  }
  if (!token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error(t('token', {}, language));
  let uploadRoot = null;
  if (env.RDF_MCP_APK_ROOT) {
    try {
      uploadRoot = realpathSync(env.RDF_MCP_APK_ROOT);
      if (!statSync(uploadRoot).isDirectory()) throw new Error();
    } catch { throw new Error(t('uploadRoot', {}, language)); }
  }
  return Object.freeze({ url: url.origin, token, language, uploadRoot });
}
