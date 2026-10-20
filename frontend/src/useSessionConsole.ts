import { useEffect, useRef, useState } from 'react';
import { api, type AdbResult } from './api';
import { t } from './i18n';
import { completionForCommand, consoleCommandLabel, consoleSuggestions, dynamicConsoleHints, parseConsoleCommand, parseDynamicNames, searchConsoleCatalog, type ConsoleCommandCategory, type ConsoleCommandHint, type DynamicCatalogKind } from './console-commands';

function requestedDynamicKinds(value: string): DynamicCatalogKind[] {
  const input = consoleCommandLabel(value).trim();
  if (/^cmd(?:\s|$)/i.test(input)) return ['cmd'];
  if (/^dumpsys(?:\s|$)/i.test(input)) return ['dumpsys'];
  if (/^(?:pm (?:path|dump|clear)|am force-stop|uninstall)(?:\s|$)/i.test(input)) return ['packages'];
  return [];
}

const DYNAMIC_ARGV: Record<DynamicCatalogKind, string[]> = {
  cmd: ['shell', 'cmd', '-l'],
  dumpsys: ['shell', 'dumpsys', '-l'],
  packages: ['shell', 'pm', 'list', 'packages', '-3'],
};


function errorText(error: unknown): string { return error instanceof Error ? error.message : t('ui.b9f61453dd3f'); }

export function useSessionConsole(sessionId: string, running: boolean, allowed: boolean) {
  const [command, setCommand] = useState('');
  const [shellHistory, setShellHistory] = useState<Array<{ command: string; result?: AdbResult; error?: string }>>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategory, setCatalogCategory] = useState<ConsoleCommandCategory | 'all'>('all');
  const [consoleNotice, setConsoleNotice] = useState('');
  const [dynamicState, setDynamicState] = useState<{ sessionId: string; names: { cmd: string[]; dumpsys: string[]; packages: string[] } }>({ sessionId, names: { cmd: [], dumpsys: [], packages: [] } });
  const dynamicNames = dynamicState.sessionId === sessionId ? dynamicState.names : { cmd: [], dumpsys: [], packages: [] };
  const dynamicSessionRef = useRef(sessionId);
  const dynamicLoadedRef = useRef(new Set<DynamicCatalogKind>());
  const dynamicPendingRef = useRef(new Set<DynamicCatalogKind>());
  const dynamicRetryAfterRef = useRef<Record<DynamicCatalogKind, number>>({ cmd: 0, dumpsys: 0, packages: 0 });
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const commandDraftRef = useRef('');
  const commandInputRef = useRef<HTMLInputElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);

  dynamicSessionRef.current = sessionId;
  const scope = useRef({ active: true });
  useEffect(() => {
    const current = { active: true }; scope.current = current;
    setShellHistory([]); setShellBusy(false); setCommand(''); setConsoleNotice('');
    setHistoryIndex(null); setSuggestionsOpen(false); setCatalogOpen(false);
    return () => { current.active = false; };
  }, [sessionId]);
  const suggestions = consoleSuggestions(command, dynamicConsoleHints(command, dynamicNames));
  const catalogResults = searchConsoleCatalog(catalogQuery, catalogCategory, dynamicConsoleHints(catalogQuery, dynamicNames));

  useEffect(() => {
    dynamicSessionRef.current = sessionId;
    dynamicLoadedRef.current.clear();
    dynamicPendingRef.current.clear();
    dynamicRetryAfterRef.current = { cmd: 0, dumpsys: 0, packages: 0 };
    setDynamicState({ sessionId, names: { cmd: [], dumpsys: [], packages: [] } });
  }, [sessionId]);

  useEffect(() => {
    if (!allowed || !running) return;
    const requested = [...new Set([
      ...requestedDynamicKinds(command),
      ...(catalogOpen ? requestedDynamicKinds(catalogQuery) : []),
    ])];
    for (const kind of requested) {
      if (dynamicLoadedRef.current.has(kind) || dynamicPendingRef.current.has(kind) || Date.now() < dynamicRetryAfterRef.current[kind]) continue;
      dynamicPendingRef.current.add(kind);
      const requestedSession = sessionId;
      const current = scope.current;
      void api.adb(sessionId, DYNAMIC_ARGV[kind]).then(result => {
        if (!current.active || dynamicSessionRef.current !== requestedSession) return;
        if (result.exitCode !== 0) {
          dynamicRetryAfterRef.current[kind] = Date.now() + 10_000;
          return;
        }
        dynamicLoadedRef.current.add(kind);
        setDynamicState(current => current.sessionId === requestedSession
          ? { sessionId: requestedSession, names: { ...current.names, [kind]: parseDynamicNames(result.stdout, kind) } }
          : current);
      }).catch(() => {
        if (current.active && dynamicSessionRef.current === requestedSession) dynamicRetryAfterRef.current[kind] = Date.now() + 10_000;
      }).finally(() => {
        if (current.active && dynamicSessionRef.current === requestedSession) dynamicPendingRef.current.delete(kind);
      });
    }
  }, [sessionId, running, allowed, command, catalogOpen, catalogQuery]);

  const insertConsoleHint = (hint: ConsoleCommandHint) => {
    const completion = completionForCommand(hint);
    if (!completion) {
      setConsoleNotice(hint.description);
      setSuggestionsOpen(false);
      return;
    }
    setCommand(completion);
    setCatalogOpen(false);
    setConsoleNotice('');
    setSuggestionsOpen(false);
    setSuggestionIndex(-1);
    setHistoryIndex(null);
    commandInputRef.current?.focus();
  };

  const executeConsoleCommand = async (value: string) => {
    const next = value.trim();
    if (!next || shellBusy || !running || !allowed) return;
    const current = scope.current;
    let argv: string[];
    try {
      argv = parseConsoleCommand(next);
    } catch (error) {
      setConsoleNotice(errorText(error));
      setSuggestionsOpen(false);
      return;
    }
    setConsoleNotice('');
    setCommand(''); setShellBusy(true);
    setSuggestionsOpen(false); setSuggestionIndex(-1); setHistoryIndex(null);
    try {
      const result = await api.adb(sessionId, argv);
      if (!current.active) return;
      setShellHistory(items => [...items, { command: consoleCommandLabel(next), result }].slice(-100));
    } catch (error) { if (current.active) setShellHistory(items => [...items, { command: consoleCommandLabel(next), error: errorText(error) }].slice(-100)); }
    finally { if (current.active) setShellBusy(false); }
  };

  const runCommand = (event: React.FormEvent) => {
    event.preventDefault();
    void executeConsoleCommand(command);
  };

  const handleCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const hints = suggestions;
    if (event.key === 'Escape' && suggestionsOpen) {
      event.preventDefault(); setSuggestionsOpen(false); setSuggestionIndex(-1); return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && suggestionsOpen && suggestionIndex >= 0 && hints[suggestionIndex]) {
      event.preventDefault(); insertConsoleHint(hints[suggestionIndex]); return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    if (historyIndex !== null) {
      event.preventDefault();
      const next = historyIndex + direction;
      if (next >= shellHistory.length) { setHistoryIndex(null); setCommand(commandDraftRef.current); }
      else if (next >= 0) { setHistoryIndex(next); setCommand(shellHistory[next].command); }
      return;
    }
    if (suggestionsOpen && hints.length) {
      event.preventDefault();
      setSuggestionIndex(current => current < 0 ? (direction > 0 ? 0 : hints.length - 1) : (current + direction + hints.length) % hints.length);
      return;
    }
    if (direction < 0 && shellHistory.length) {
      event.preventDefault();
      commandDraftRef.current = command;
      setHistoryIndex(shellHistory.length - 1);
      setCommand(shellHistory[shellHistory.length - 1].command);
    }
  };

  useEffect(() => {
    const output = terminalOutputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [shellHistory.length, shellBusy]);


  return {
    command, setCommand, shellHistory, setShellHistory, shellBusy,
    suggestionsOpen, setSuggestionsOpen, suggestionIndex, setSuggestionIndex,
    catalogOpen, setCatalogOpen, catalogQuery, setCatalogQuery, catalogCategory, setCatalogCategory,
    consoleNotice, setConsoleNotice, setHistoryIndex, commandInputRef, terminalOutputRef,
    suggestions, catalogResults, insertConsoleHint, runCommand, handleCommandKeyDown,
  };
}
