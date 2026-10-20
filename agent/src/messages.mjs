import dictionary from './generated/messages.json' with { type: 'json' };
export function agentMessage(key, params = {}, language = 'en') {
  const entry = dictionary[key];
  if (!entry) throw new Error('Missing agent message: ' + key);
  return entry[language].replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? String(params[name] ?? '') : placeholder);
}
