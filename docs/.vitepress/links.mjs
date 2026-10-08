import path from 'node:path';
import { downloadFiles } from './downloads.mjs';

export const repository = 'https://github.com/kavabunga6/remote-device-farm';

// Keep source Markdown useful on GitHub while resolving site links after README rewrites.
export function rewriteDocumentationLink(href, source = 'README.md') {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) return href;
  const [, target, suffix = ''] = href.match(/^([^?#]*)([?#].*)?$/) || [];
  if (!target) return href;
  const original = source.replaceAll('\\', '/');
  const resolved = path.posix.normalize(path.posix.join('docs', path.posix.dirname(original), target));
  if (!resolved.startsWith('docs/')) {
    if (resolved.startsWith('../')) return href;
    if (downloadFiles.includes(resolved)) return `/downloads/${resolved}${suffix}`;
    if (target.endsWith('/') && downloadFiles.some(file => file.startsWith(resolved.replace(/\/$/, '') + '/'))) return `/downloads/${resolved.replace(/\/$/, '')}/index.html${suffix}`;
    const kind = target.endsWith('/') ? 'tree' : 'blob';
    return `${repository}/${kind}/main/${resolved}${suffix}`;
  }
  const local = resolved.slice('docs/'.length).replace(/(^|\/)README\.md$/, '$1index.md');
  return `/${local}${suffix}`;
}
