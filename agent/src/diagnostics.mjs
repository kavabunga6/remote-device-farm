import messages from './generated/diagnostics.json' with { type: 'json' };

// Keep operational diagnostics stable across UI language changes.
export function diagnostic(key, params = {}) {
  const message = messages[key];
  if (message === undefined) throw new Error('Missing diagnostic key: ' + key);
  return message.replace(/\{(p\d+)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}
