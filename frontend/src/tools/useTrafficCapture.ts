import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { useNotifications } from '../notifications';
import { debugApi, downloadDebug, type TrafficState } from './debug-api';

export function useTrafficCapture(sessionId: string, active: boolean, running: boolean) {
  const [state, setState] = useState<TrafficState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { notifyError } = useNotifications();
  const current = useRef(sessionId);
  const pending = useRef<AbortController | null>(null);
  const revision = useRef(0), acting = useRef(false);

  useEffect(() => {
    current.current = sessionId;
    revision.current++;
    setState(null); setBusy(false); setError('');
    return () => { current.current = ''; pending.current?.abort(); };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (pending.current || acting.current) return;
    const abort = new AbortController();
    pending.current = abort;
    const version = ++revision.current;
    try {
      const next = await debugApi<TrafficState>(sessionId, 'network-inspector', undefined, abort.signal);
      if (current.current === sessionId && !abort.signal.aborted && revision.current === version) {
        setState(next); setError('');
      }
    } catch (cause) {
      if (current.current === sessionId && !abort.signal.aborted && revision.current === version)
        setError(cause instanceof Error ? cause.message : t('networkInspector.failed'));
    } finally {
      if (pending.current === abort) pending.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!active || !running) return;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => { pending.current?.abort(); clearInterval(timer); };
  }, [active, running, refresh]);

  const action = async (op: 'start' | 'stop' | 'clear', pcap = false) => {
    if (acting.current) return false;
    acting.current = true; revision.current++; setBusy(true);
    try {
      const next = await debugApi<TrafficState>(sessionId, 'network-inspector', { op, ...(op === 'start' ? { pcap } : {}) });
      if (current.current !== sessionId) return false;
      setState(next); setError('');
      return true;
    } catch (cause) {
      if (current.current === sessionId) notifyError(t('networkInspector.failed'), cause);
      return false;
    } finally {
      acting.current = false;
      if (current.current === sessionId) setBusy(false);
    }
  };

  const exportPcap = async () => {
    if (acting.current) return;
    acting.current = true; revision.current++; setBusy(true);
    try {
      const chunks: BlobPart[] = [];
      let offset = 0, total = -1;
      while (current.current === sessionId) {
        const part = await debugApi<{ contentBase64: string; offset: number; size: number }>(sessionId, 'network-inspector', { op: 'pcap', offset });
        if (part.offset !== offset || part.size < 0 || part.size > 40 * 1024 * 1024 || (total >= 0 && total !== part.size))
          throw new Error(t('networkInspector.exportFailed'));
        total = part.size;
        const bytes = Uint8Array.from(atob(part.contentBase64), c => c.charCodeAt(0));
        if (!bytes.length && offset < total) throw new Error(t('networkInspector.exportFailed'));
        chunks.push(bytes.buffer); offset += bytes.length;
        if (offset === total) {
          if (current.current === sessionId) downloadDebug('session-' + sessionId.slice(0, 8) + '.pcap', chunks, 'application/vnd.tcpdump.pcap');
          break;
        }
        if (offset > total) throw new Error(t('networkInspector.exportFailed'));
      }
    } catch (cause) {
      if (current.current === sessionId) notifyError(t('networkInspector.exportFailed'), cause);
    } finally {
      acting.current = false;
      if (current.current === sessionId) setBusy(false);
    }
  };
  return { state, busy, error, refresh, action, exportPcap };
}
