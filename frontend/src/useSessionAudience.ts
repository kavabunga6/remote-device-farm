import { can } from './permissions';
import { t } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceSession, User } from './api';
import { shareApi } from './share-api';
import { deriveSessionAudience, type AudienceSnapshot, type SessionAudience } from './session-audience';

export interface SessionAudienceController extends SessionAudience {
  refresh: () => Promise<void>;
  forgetShare: (shareId: string) => void;
  forgetGrant: (shareId: string, grantId: string) => void;
}

export function useSessionAudience(session: DeviceSession | null, user: User): SessionAudienceController {
  const sessionId = session?.id;
  const owner = !!session && session.ownerId === user.id;
  const readable = can(user, 'sessions.share') && owner && session?.status !== 'stopped';
  const key = [sessionId || '', user.id, owner, readable].join(':');
  const initial: AudienceSnapshot = { status: !session ? 'loading' : !owner || !can(user, 'sessions.share') ? 'unavailable' : session.status === 'stopped' ? 'ready' : 'loading', shares: [], updatedAt: null, error: '' };
  const [snapshot, setSnapshot] = useState<AudienceSnapshot & { key: string }>({ ...initial, key });
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef<AbortController | null>(null);
  const request = useCallback(async (force: boolean) => {
    if (!sessionId || !readable) return;
    if (inFlight.current && !force) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const shares = await shareApi.list(sessionId, controller.signal);
      if (controller.signal.aborted || inFlight.current !== controller) return;
      const receivedAt = Date.now();
      setNow(receivedAt);
      setSnapshot({ key, status: 'ready', shares, updatedAt: receivedAt, error: '' });
    } catch (error) {
      if (controller.signal.aborted || inFlight.current !== controller) return;
      setSnapshot(previous => ({ ...(previous.key === key ? previous : { shares: [], updatedAt: null }), key, status: 'error', error: error instanceof Error ? error.message : t('ui.0ce0e54595cc') }));
    } finally { if (inFlight.current === controller) inFlight.current = null; }
  }, [key, sessionId, readable]);
  const refresh = useCallback(() => request(true), [request]);

  useEffect(() => {
    setSnapshot({ ...initial, key });
    if (!readable) return;
    void request(false);
    const poll = window.setInterval(() => void request(false), 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (!document.hidden) void request(false); };
    window.addEventListener('online', onVisible);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      inFlight.current?.abort(); inFlight.current = null;
      window.clearInterval(poll); window.clearInterval(clock);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // The key represents every ownership/session transition. Whole session objects refresh often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readable, request]);

  const forgetShare = useCallback((shareId: string) => {
    inFlight.current?.abort(); inFlight.current = null;
    setSnapshot(previous => previous.key === key ? { ...previous, shares: previous.shares.filter(share => share.id !== shareId) } : previous);
  }, [key]);
  const forgetGrant = useCallback((shareId: string, grantId: string) => {
    inFlight.current?.abort(); inFlight.current = null;
    setSnapshot(previous => previous.key === key ? { ...previous, shares: previous.shares.map(share => share.id === shareId ? { ...share, redeemers: share.redeemers.filter(person => person.grantId !== grantId) } : share) } : previous);
  }, [key]);
  return { ...deriveSessionAudience(snapshot.key === key ? snapshot : initial, now), refresh, forgetShare, forgetGrant };
}
