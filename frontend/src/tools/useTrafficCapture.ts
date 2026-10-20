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
  const owner = useRef({});
  const pending = useRef<AbortController | null>(null);
  const revision = useRef(0), acting = useRef(false);

  useEffect(() => {
    current.current = sessionId;
    owner.current = {}; acting.current = false;
    pending.current?.abort(); pending.current = null;
    revision.current++;
    setState(null); setBusy(false); setError('');
    return () => { current.current = ''; owner.current = {}; pending.current?.abort(); };
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

  const action = async (op: 'start' | 'stop' | 'clear', pcap = false, captureBodies = false) => {
    if (acting.current) return false;
    const generation = owner.current;
    acting.current = true; revision.current++; setBusy(true);
    try {
      const next = await debugApi<TrafficState>(sessionId, 'network-inspector', { op, ...(op === 'start' ? { pcap, captureBodies } : {}) });
      if (current.current !== sessionId || owner.current !== generation) return false;
      setState(next); setError('');
      return true;
    } catch (cause) {
      if (current.current === sessionId && owner.current === generation) notifyError(t('networkInspector.failed'), cause);
      return false;
    } finally {
      if (owner.current === generation) { acting.current = false; setBusy(false); }
    }
  };

  const exportPcap = async () => {
    if (acting.current) return;
    const generation = owner.current;
    acting.current = true; revision.current++; setBusy(true);
    try {
      const chunks: BlobPart[] = [];
      const captureId = state?.captureId;
      let offset = 0, total = -1;
      while (current.current === sessionId && owner.current === generation) {
        const part = await debugApi<{ contentBase64: string; offset: number; size: number; captureId?: string }>(sessionId, 'network-inspector', { op: 'pcap', offset, ...(captureId ? { captureId } : {}) });
        if (owner.current !== generation || current.current !== sessionId) return;
        if ((captureId && part.captureId !== captureId) || part.offset !== offset || part.size < 0 || part.size > 40 * 1024 * 1024 || (total >= 0 && total !== part.size))
          throw new Error(t('networkInspector.exportFailed'));
        total = part.size;
        const bytes = Uint8Array.from(atob(part.contentBase64), c => c.charCodeAt(0));
        if (!bytes.length && offset < total) throw new Error(t('networkInspector.exportFailed'));
        chunks.push(bytes.buffer); offset += bytes.length;
        if (offset === total) {
          if (current.current === sessionId && owner.current === generation) downloadDebug('session-' + sessionId.slice(0, 8) + '.pcap', chunks, 'application/vnd.tcpdump.pcap');
          break;
        }
        if (offset > total) throw new Error(t('networkInspector.exportFailed'));
      }
    } catch (cause) {
      if (current.current === sessionId && owner.current === generation) notifyError(t('networkInspector.exportFailed'), cause);
    } finally {
      if (owner.current === generation) { acting.current = false; setBusy(false); }
    }
  };
  return { state, busy, error, refresh, action, exportPcap };
}
