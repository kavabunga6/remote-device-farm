import { getLocale, t } from './i18n';
import { getConsoleCommands, type ConsoleCommandCategory, type ConsoleCommandHint } from './console-catalog';

export { CONSOLE_CATEGORIES, getConsoleCommands } from './console-catalog';
export type { ConsoleCommandCategory, ConsoleCommandHint } from './console-catalog';

const ALLOWED_ADB_COMMANDS = new Set(['shell', 'logcat', 'uninstall', 'get-state', 'get-serialno', 'reboot', 'devices', 'version']);
const NO_ARGUMENT_COMMANDS = new Set(['get-state', 'get-serialno', 'devices', 'version']);
const HOST_ADB_COMMANDS = new Set([
  'start-server', 'kill-server', 'connect', 'disconnect', 'pair', 'usb', 'tcpip', 'forward', 'reverse',
  'root', 'unroot', 'remount', 'sideload', 'install', 'install-multiple', 'install-multi-package',
  'push', 'pull', 'exec-out', 'sync', 'wait-for-device', 'wait-for-bootloader', 'track-devices',
  'reconnect', 'disable-verity', 'enable-verity', 'backup', 'restore', 'keygen', 'server-status',
  'mdns', 'host-features', 'features', 'get-devpath', 'bugreport', 'emu', 'jdwp',
]);
const TEMPLATE_PATTERN = /<[^<>\r\n]{1,80}>/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,80}$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{1,150}$/;

export function consoleCommandLabel(value: string): string {
  const input = value.trim();
  return /^adb(?:\s|$)/i.test(input) ? input.slice(3).trim() || t('ui.ed5c44a4e8b0') : input;
}

export function isConsoleTemplate(value: string): boolean {
  return TEMPLATE_PATTERN.test(value);
}

export function completionForCommand(hint: ConsoleCommandHint): string | null {
  return hint.access === 'console' ? hint.command : null;
}

function splitArgs(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; continue; }
    if (quote) {
      if (character === quote) { quote = null; continue; }
      if (character === '\\' && quote === '"') { escaped = true; continue; }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { result.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote || escaped) throw new Error(t('ui.e1139f98c53d'));
  if (started) result.push(current);
  if (result.some(part => !part)) throw new Error(t('ui.b17593c94796'));
  return result;
}

export function parseConsoleCommand(value: string): string[] {
  const input = value.trim();
  if (!input) throw new Error(t('ui.231fba8286d2'));
  if (/[\r\n\0]/.test(input)) throw new Error(t('ui.700067a262d7'));
  if (isConsoleTemplate(input)) throw new Error(t('ui.6510100da483'));
  const hadAdbPrefix = /^adb(?:\s|$)/i.test(input);
  const command = hadAdbPrefix ? input.slice(3).trim() : input;
  if (!command) throw new Error(t('ui.1881ccfb4ba3'));
  const firstSpace = command.search(/\s/);
  const operation = (firstSpace < 0 ? command : command.slice(0, firstSpace)).toLowerCase();
  const argumentsText = firstSpace < 0 ? '' : command.slice(firstSpace).trim();
  if (operation.startsWith('-')) throw new Error(t('ui.7e2ccf26b838'));
  if (operation === 'connect') throw new Error(t('ui.92fc66c8762f'));
  if (operation === 'install' || operation === 'push') throw new Error(t('ui.c1d62ad8d9c8'));
  if (operation === 'pull') throw new Error(t('ui.258590e543a7'));
  if (operation === 'exec-out') throw new Error(t('ui.4a65152ea3e2'));
  if (HOST_ADB_COMMANDS.has(operation)) throw new Error(t('ui.21cdb66ca418'));
  if (!ALLOWED_ADB_COMMANDS.has(operation)) {
    if (hadAdbPrefix) throw new Error(t('ui.f0a524370a24'));
    return ['shell', input];
  }
  if (operation === 'shell') {
    if (!argumentsText) throw new Error(t('ui.8f4023dbc02f'));
    return ['shell', argumentsText];
  }
  if (NO_ARGUMENT_COMMANDS.has(operation)) {
    if (argumentsText) throw new Error(t('copy.console-commands.658b8cac', { p0: operation }));
    return [operation];
  }
  const args = splitArgs(argumentsText);
  if (operation === 'logcat' && !args.includes('-d')) throw new Error(t('ui.8cebcd3b8897'));
  return [operation, ...args];
}

function normalized(value: string): string {
  return value.toLocaleLowerCase(getLocale());
}

function searchScore(hint: ConsoleCommandHint, query: string): number {
  if (!query) return 1;
  const words = normalized(query).split(/\s+/).filter(Boolean);
  const command = normalized(hint.command);
  const label = normalized(hint.label);
  const searchable = normalized([hint.command, hint.label, hint.description, hint.keywords, hint.category].join(' '));
  if (!words.every(word => searchable.includes(word))) return -1;
  return (command === normalized(query) ? 100 : command.startsWith(normalized(query)) ? 70 : 0)
    + (label.startsWith(normalized(query)) ? 45 : 0)
    + words.filter(word => command.includes(word)).length * 10
    + words.filter(word => label.includes(word)).length * 5;
}

export function searchConsoleCatalog(query: string, category: ConsoleCommandCategory | 'all' = 'all', dynamic: ConsoleCommandHint[] = [], limit = 100): ConsoleCommandHint[] {
  const entries = [...getConsoleCommands(), ...dynamic];
  return entries
    .map((hint, index) => ({ hint, index, score: searchScore(hint, consoleCommandLabel(query).trim()) }))
    .filter(item => item.score >= 0 && (category === 'all' || item.hint.category === category))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(item => item.hint);
}

export function consoleSuggestions(value: string, dynamic: ConsoleCommandHint[] = [], limit = 8): ConsoleCommandHint[] {
  const query = consoleCommandLabel(value).trim();
  if (!query) return [];
  return searchConsoleCatalog(query, 'all', dynamic, limit);
}

export type DynamicCatalogKind = 'cmd' | 'dumpsys' | 'packages';

export function parseDynamicNames(output: string, kind: DynamicCatalogKind): string[] {
  const pattern = kind === 'packages' ? PACKAGE_NAME_PATTERN : SERVICE_NAME_PATTERN;
  const names = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const value = kind === 'packages' ? trimmed.replace(/^package:/, '') : trimmed;
    if (!pattern.test(value) || (kind === 'packages' && !trimmed.startsWith('package:'))) continue;
    names.add(value);
    if (names.size >= 256) break;
  }
  return [...names];
}

export function dynamicConsoleHints(query: string, services: { cmd: string[]; dumpsys: string[]; packages: string[] }): ConsoleCommandHint[] {
  const input = consoleCommandLabel(query).trim();
  const prefix = /^(pm (?:path|dump|clear)|am force-stop|uninstall)(?:\s|$)/i.exec(input)?.[1];
  let kind: DynamicCatalogKind | null = null;
  if (/^cmd(?:\s|$)/i.test(input)) kind = 'cmd';
  else if (/^dumpsys(?:\s|$)/i.test(input)) kind = 'dumpsys';
  else if (prefix) kind = 'packages';
  if (!kind) return [];
  return services[kind].slice(0, 256).map(name => {
    const command = kind === 'cmd' ? t('copy.console-commands.c9a90302', { p0: name })
      : kind === 'dumpsys' ? 'dumpsys ' + name : prefix + ' ' + name;
    return {
      command, syntax: command, label: name,
      description: kind === 'packages' ? t('ui.f147c661dd05') : t('ui.704dbd797a64'),
      category: kind === 'packages' ? 'packages' : 'services',
      access: 'console', arguments: kind === 'cmd' ? t('ui.6c8e2ac99851') : t('ui.4ee203a82700'),
      example: kind === 'cmd' ? 'cmd ' + name + ' help' : command,
      keywords: name, dynamic: true,
      caution: kind === 'packages' && /^(?:pm clear|am force-stop|uninstall)$/i.test(prefix || '') ? t('ui.122f95bc5bfa') : undefined,
    };
  });
}
