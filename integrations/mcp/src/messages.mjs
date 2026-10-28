import messages from './messages.json' with { type: 'json' };

export const supportedLanguages = Object.freeze(Object.keys(messages['mcp.config']));

export function t(key, params = {}, language = 'en') {
  if (!supportedLanguages.includes(language)) throw new Error(messages['mcp.config'].en);
  const entry = messages['mcp.' + key];
  if (!entry) throw new Error('Missing message key: mcp.' + key);
  return entry[language].replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
