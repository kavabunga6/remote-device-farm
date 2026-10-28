import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Icon } from '../icons';
import { debugApi } from './debug-api';
import './DeviceDebug.css';
type Page = { target: string; title: string; url: string };
export function WebViewsPanel({ sessionId, active, running }: { sessionId: string; active: boolean; running: boolean }) {
  const [pages, setPages] = useState<Page[]>([]), [target, setTarget] = useState('');
  const [expression, setExpression] = useState(''), [output, setOutput] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const current = useRef(sessionId);
  useEffect(() => { current.current = sessionId; setPages([]); setTarget(''); setOutput(''); return () => { current.current = ''; }; }, [sessionId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const result = await debugApi<{ pages: Page[] }>(sessionId, 'webviews', undefined, signal);
      if (current.current !== sessionId || signal?.aborted) return;
      setPages(result.pages); setTarget(previous => result.pages.some(page => page.target === previous) ? previous : result.pages[0]?.target ?? ''); setError('');
    } catch (cause) { if (current.current === sessionId && !signal?.aborted) setError(cause instanceof Error ? cause.message : t('webviews.failed')); }
    finally { if (current.current === sessionId && !signal?.aborted) setBusy(false); }
  }, [sessionId]);
  useEffect(() => { if (!active || !running) return; const abort = new AbortController(); void refresh(abort.signal); return () => abort.abort(); }, [active, running, refresh]);
  const inspect = async (op: 'document' | 'evaluate') => {
    if (busy || !target) return; setBusy(true); setError('');
    try {
      const result = await debugApi<{ result: { result?: { value?: unknown }; exceptionDetails?: unknown } }>(sessionId, 'webviews', { op, target, ...(op === 'evaluate' ? { expression } : {}) });
      if (current.current === sessionId) {
        const value = result.result.exceptionDetails ?? result.result.result?.value ?? result.result;
        setOutput(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      }
    } catch (cause) { if (current.current === sessionId) setError(cause instanceof Error ? cause.message : t('webviews.failed')); }
    finally { if (current.current === sessionId) setBusy(false); }
  };
  return <section className="device-debug-panel" id="tool-panel-webviews" role="tabpanel" aria-labelledby="tool-tab-webviews" hidden={!active}>
    <div className="device-debug-head"><div><h2>{t('webviews.title')}</h2><p>{t('webviews.description')}</p></div>
      <button className="button" disabled={!running || busy} onClick={() => void refresh()} aria-label={t('debug.refresh')}><Icon name="refresh" size={16}/></button></div>
    {!running ? <p>{t('debug.stopped')}</p> : !pages.length && !busy ? <p className="device-debug-hint">{t('webviews.empty')}</p> : null}
    {error && <div className="banner-error" role="alert">{error}</div>}
    {pages.length > 0 && <>
      <label className="device-debug-field">{t('webviews.page')}<select value={target} onChange={event => { setTarget(event.target.value); setOutput(''); }} disabled={busy}>
        {pages.map(page => <option key={page.target} value={page.target}>{page.title || page.url}</option>)}</select></label>
      <p className="device-debug-endpoint">{pages.find(page => page.target === target)?.url}</p>
      <div className="device-debug-actions"><button className="button" disabled={busy} onClick={() => void inspect('document')}>{busy ? t('debug.working') : t('webviews.document')}</button></div>
      <form onSubmit={event => { event.preventDefault(); void inspect('evaluate'); }} className="device-debug-field">
        <label htmlFor="webview-expression">{t('webviews.expression')}</label>
        <textarea id="webview-expression" value={expression} maxLength={16384} onChange={event => setExpression(event.target.value)} disabled={busy} spellCheck={false}/>
        <p className="device-debug-hint">{t('webviews.scriptHint')}</p>
        <div className="device-debug-actions"><button type="submit" className="button primary" disabled={busy || !expression.trim()}><Icon name="play" size={16}/>{t('webviews.run')}</button></div>
      </form>
    </>}
    {busy && <div className="device-debug-state" role="status"><span className="mini-spinner"/>{t('debug.working')}</div>}
    {output && <pre className="device-debug-code" tabIndex={0}>{output}</pre>}
    <div className="device-debug-field"><span>{t('webviews.appium')}</span><code className="device-debug-endpoint">{location.origin + '/api/sessions/' + sessionId + '/appium'}</code></div>
  </section>;
}
