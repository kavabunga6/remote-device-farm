import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { agentMessage } from './messages.mjs';
const errors = {
  unavailable: () => agentMessage('agent.ui.unavailable'),
  selector: () => agentMessage('agent.ui.selector'),
  busy: () => agentMessage('agent.ui.busy'),
  notFound: () => agentMessage('agent.ui.notFound'),
  ambiguous: () => agentMessage('agent.ui.ambiguous'),
  inputFailed: () => agentMessage('agent.ui.inputFailed'),
  notActionable: () => agentMessage('agent.ui.notActionable')
};
const fail = key => { throw new Error(errors[key]()); };
const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (Object.hasOwn(named, entity)) return named[entity];
  const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});

// Fixed UIAutomator XML vocabulary, without DTDs or external resources.
export function parseHierarchy(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!/i.test(xml)) fail('unavailable');
  const source = xml.replace(/^\s*<\?xml[^?]*\?>/, '').trim();
  const nodes = [], stack = [];
  let offset = 0, root = false;
  for (const token of source.matchAll(/<\/?(?:hierarchy|node)\b[^>]*>/g)) {
    if (source.slice(offset, token.index).trim()) fail('unavailable');
    offset = token.index + token[0].length;
    const tag = token[0], name = /^<\/?(\w+)/.exec(tag)[1];
    if (tag.startsWith('</')) {
      if (tag !== '</' + name + '>' || stack.pop()?.name !== name) fail('unavailable');
      continue;
    }
    if (name === 'hierarchy') {
      if (root || stack.length) fail('unavailable');
      root = true;
    } else if (!stack.length || nodes.length >= 2000 || stack.length > 64) fail('unavailable');
    const attrs = Object.create(null);
    const raw = tag.slice(name.length + 1, tag.endsWith('/>') ? -2 : -1);
    let end = 0;
    for (const attr of raw.matchAll(/([a-zA-Z][\w-]*)="([^"<>]*)"/g)) {
      if (raw.slice(end, attr.index).trim() || Object.hasOwn(attrs, attr[1])) fail('unavailable');
      end = attr.index + attr[0].length;
      attrs[attr[1]] = decode(attr[2]).slice(0, 2048);
    }
    if (raw.slice(end).trim()) fail('unavailable');
    let node = null;
    if (name === 'node') {
      const bounds = /^\[(-?\d{1,5}),(-?\d{1,5})\]\[(-?\d{1,5}),(-?\d{1,5})\]$/.exec(attrs.bounds || '');
      node = { id: nodes.length, parentId: stack.at(-1)?.node?.id ?? null,
        text: attrs.password === 'true' ? '' : attrs.text || '', resourceId: attrs['resource-id'] || '',
        description: attrs.password === 'true' ? '' : attrs['content-desc'] || '', className: attrs.class || '',
        packageName: attrs.package || '', password: attrs.password === 'true', enabled: attrs.enabled === 'true',
        clickable: attrs.clickable === 'true', focusable: attrs.focusable === 'true', scrollable: attrs.scrollable === 'true',
        bounds: bounds ? bounds.slice(1).map(Number) : null };
      nodes.push(node);
    }
    if (!tag.endsWith('/>')) stack.push({ name, node });
  }
  if (!root || stack.length || source.slice(offset).trim() || !nodes.length) fail('unavailable');
  return { nodes };
}

export function validateSelector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['text', 'resourceId', 'description', 'exact', 'index'].includes(k))) fail('selector');
  const keys = ['text', 'resourceId', 'description'].filter(k => value[k] !== undefined);
  if (!keys.length || keys.some(k => typeof value[k] !== 'string' || !value[k].length || value[k].length > 512 || /[\x00-\x1f\x7f]/.test(value[k])) ||
      (value.exact !== undefined && typeof value.exact !== 'boolean') ||
      (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 0 || value.index > 1999))) fail('selector');
  return { ...value, exact: value.exact !== false };
}

export function findElements(tree, raw) {
  const selector = validateSelector(raw);
  const matches = tree.nodes.filter(node => ['text', 'resourceId', 'description'].every(key => selector[key] === undefined ||
    (selector.exact ? node[key] === selector[key] : node[key].includes(selector[key]))));
  return selector.index === undefined ? matches : matches.slice(selector.index, selector.index + 1);
}

export class UiHierarchy {
  constructor(adb) { this.adb = adb; this.pending = new Set(); }
  async read(serial, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.pending.has(serial) || this.pending.size >= 4) fail('busy');
    this.pending.add(serial);
    const file = '/data/local/tmp/rdf-ui-' + randomUUID() + '.xml';
    try {
      const deadline = Date.now() + 23_000;
      for (let attempt = 0; attempt < 2; attempt++) {
        const dump = await this.adb.run(serial, ['shell', '/system/bin/timeout', '-s', 'KILL', '9', 'uiautomator', 'dump', '--compressed', file], {timeoutMs:Math.min(10000,Math.max(1,deadline-Date.now())),maxOutputBytes:8192,signal});
        if (dump.exitCode !== 0 && ![124,137].includes(dump.exitCode)) fail('unavailable');
        // Some Android builds return success while no XML was created yet.
        // Retrying a read is safe; the eventual input command is never replayed.
        if (dump.exitCode === 0 && !/null root node|could not get idle state/i.test(String(dump.stdout)+'\n'+String(dump.stderr))) break;
        if (attempt || deadline-Date.now()<1000) fail('unavailable');
        await delay(250,undefined,{signal});
      }
      const result = await this.adb.run(serial, ['exec-out', 'cat', file], { timeoutMs: Math.min(2000,Math.max(1,deadline-Date.now())), maxOutputBytes: 2 * 1024 * 1024, signal });
      if (result.exitCode !== 0) fail('unavailable');
      return parseHierarchy(String(result.stdout));
    } catch { signal?.throwIfAborted();fail('unavailable'); } finally {
      await this.adb.run(serial, ['shell', 'rm', '-f', file], { timeoutMs: 1000, maxOutputBytes: 1024 }).catch(() => {});
      this.pending.delete(serial);
    }
  }
  async tap(serial, selector, { signal } = {}) {
    validateSelector(selector);
    const matches = findElements(await this.read(serial, { signal }), selector);
    signal?.throwIfAborted();
    if (!matches.length) fail('notFound');
    if (matches.length !== 1) fail('ambiguous');
    const node = matches[0], b = node.bounds;
    if (!node.enabled || !b || b.some(v => v < 0 || v > 8192) || b[2] <= b[0] || b[3] <= b[1]) fail('notActionable');
    const x = Math.floor((b[0] + b[2]) / 2), y = Math.floor((b[1] + b[3]) / 2);
    try {
      const result = await this.adb.run(serial, ['shell', 'input', 'tap', String(x), String(y)], { timeoutMs: 3000, maxOutputBytes: 4096, signal });
      if (result.exitCode !== 0) fail('inputFailed');
    } catch { fail('inputFailed'); }
    return { tapped: true, element: node };
  }
}
