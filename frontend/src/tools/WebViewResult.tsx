import { useEffect, useState } from 'react';
import { t } from '../i18n';

const startsWithHtml = /^\s*<(?:!doctype\s+html\b|!--|[a-z][\w:-]*(?:\s|\/?>))/i;

export function WebViewResult({ source }: { source: string }) {
  const [formatted, setFormatted] = useState<{ source: string; text: string }>();
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (!startsWithHtml.test(source)) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./webview-html.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return;
    }
    const timeout = window.setTimeout(() => worker.terminate(), 10_000);
    const stop = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<string | null>) => {
      if (event.data !== null) setFormatted({ source, text: event.data });
      stop();
    };
    worker.onerror = stop;
    worker.postMessage(source);
    return stop;
  }, [source]);

  const pretty = formatted?.source === source ? formatted.text : undefined;
  return <section className="device-debug-field">
    <div className="webview-result-header">
      <h3 id="webview-result-label">{t('ui.4997a5143d9f')}</h3>
      {pretty !== undefined && <div className="webview-result-modes" role="group" aria-labelledby="webview-result-label">
        <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{t('webviews.formatted')}</button>
        <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>{t('webviews.source')}</button>
      </div>}
    </div>
    <pre className="device-debug-code" tabIndex={0} aria-labelledby="webview-result-label" dir="ltr"><code>{showSource ? source : pretty ?? source}</code></pre>
  </section>;
}
