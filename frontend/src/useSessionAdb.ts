import { useEffect, useRef, useState } from 'react';
import { api, type AdbPortAccess, type AdbUserKey, type NewAdbUserKey, type DeviceSession, type User } from './api';
import { can } from './permissions';
import { t } from './i18n';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t('ui.b9f61453dd3f');
}

/** Session ADB grant, key generation and download-confirmation state. */
export function useSessionAdb(sessionId: string, session: DeviceSession | null, user: User) {
  const [adbPortAccess, setAdbPortAccess] = useState<AdbPortAccess | null>(null);
  const [adbPublicKey, setAdbPublicKey] = useState('');
  const [adbUserKey, setAdbUserKey] = useState<AdbUserKey | null>(null);
  const [adbKeyLoaded, setAdbKeyLoaded] = useState(false);
  const [newAdbKey, setNewAdbKey] = useState<NewAdbUserKey | null>(null);
  const [privateKeyDownloaded, setPrivateKeyDownloaded] = useState(false);
  const [publicKeyDownloaded, setPublicKeyDownloaded] = useState(false);
  const [showCustomAdbKey, setShowCustomAdbKey] = useState(false);
  const [confirmKeyRotation, setConfirmKeyRotation] = useState(false);
  const [adbPortChecked, setAdbPortChecked] = useState(false);
  const autoPortAttemptRef = useRef('');
  const [adbBusy, setAdbBusy] = useState(false);
  const [adbError, setAdbError] = useState('');
  const [adbMenuOpen, setAdbMenuOpen] = useState(false);
  const [adbCopied, setAdbCopied] = useState(false);
  const adbMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!can(user, 'sessions.adb')) return;
    let active = true;
    const load = async () => {
      try {
        const result = await api.adbPortAccess(sessionId);
        if (active) { setAdbPortAccess(result.access); setAdbPortChecked(true); setAdbError(''); }
      } catch (error) {
        if (active) setAdbError(errorText(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, user.permissions]);

  useEffect(() => {
    if (!can(user, 'sessions.adb')) return;
    let active = true;
    void api.adbUserKey().then(result => {
      if (active) { setAdbUserKey(result.key); setAdbKeyLoaded(true); }
    }).catch(error => {
      if (active) { setAdbError(errorText(error)); setAdbKeyLoaded(true); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!can(user, 'sessions.adb') || !adbKeyLoaded || !adbPortChecked || !adbUserKey || adbPortAccess || session?.status !== 'running' || session.ownerId !== user.id) return;
    const attempt = sessionId + ':' + adbUserKey.fingerprint;
    if (autoPortAttemptRef.current === attempt) return;
    autoPortAttemptRef.current = attempt;
    let active = true;
    void api.createAdbPortAccess(sessionId).then(access => {
      if (active) { setAdbPortAccess(access); setAdbError(''); }
    }).catch(error => { if (active) setAdbError(errorText(error)); });
    return () => { active = false; };
  }, [adbKeyLoaded, adbPortChecked, adbUserKey, adbPortAccess, session?.status, session?.ownerId, sessionId, user.id]);

  const closeAdbMenu = () => {
    if (newAdbKey && (!privateKeyDownloaded || !publicKeyDownloaded)) {
      setAdbError(t('ui.491d9de5b6e4'));
      return;
    }
    setAdbMenuOpen(false);
    setNewAdbKey(null);
    setConfirmKeyRotation(false);
    setAdbError('');
  };

  useEffect(() => {
    if (!adbMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!adbMenuRef.current?.contains(event.target as Node)) closeAdbMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAdbMenu();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [adbMenuOpen, newAdbKey, privateKeyDownloaded, publicKeyDownloaded]);

  useEffect(() => {
    if (!adbCopied) return;
    const timer = window.setTimeout(() => setAdbCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [adbCopied]);

  const loadAdbPublicKey = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4096) { setAdbError(t('ui.a48c715e5538')); return; }
    try { setAdbPublicKey((await file.text()).trim()); setAdbError(''); }
    catch (error) { setAdbError(errorText(error)); }
  };

  const requestAdbPortAccess = async () => {
    if (showCustomAdbKey && !adbPublicKey.trim()) { setAdbError(t('ui.45097536e11d')); return; }
    if (!showCustomAdbKey && !adbUserKey) { setAdbError(t('ui.8abe8c4b8b33')); return; }
    setAdbBusy(true); setAdbError('');
    try {
      setAdbPortAccess(await api.createAdbPortAccess(sessionId, showCustomAdbKey ? adbPublicKey.trim() : undefined));
      if (!newAdbKey) setAdbMenuOpen(false);
    } catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const createAdbUserKey = async (rotate: boolean) => {
    setAdbBusy(true); setAdbError('');
    try {
      const result = rotate ? await api.rotateAdbUserKey() : await api.createAdbUserKey();
      autoPortAttemptRef.current = sessionId + ':' + result.fingerprint;
      setAdbUserKey({ fingerprint: result.fingerprint, createdAt: result.createdAt });
      setNewAdbKey(result);
      setPrivateKeyDownloaded(false); setPublicKeyDownloaded(false);
      setShowCustomAdbKey(false); setAdbPublicKey('');
      setConfirmKeyRotation(false);
      if (rotate) setAdbPortAccess(null);
      if (session?.status === 'running' && session.ownerId === user.id) {
        try { setAdbPortAccess(await api.createAdbPortAccess(sessionId)); }
        catch (error) { setAdbError(t('ui.e2eb4e7f22a4') + errorText(error)); }
      }
    } catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const revokeAdbPortAccess = async () => {
    setAdbBusy(true); setAdbError('');
    try { await api.revokeAdbPortAccess(sessionId); setAdbPortAccess(null); setAdbMenuOpen(false); }
    catch (error) { setAdbError(errorText(error)); }
    finally { setAdbBusy(false); }
  };

  const copyAdbCommand = async () => {
    if (!adbPortAccess) return;
    try {
      await navigator.clipboard.writeText('adb connect ' + adbPortAccess.host + ':' + adbPortAccess.port);
      setAdbCopied(true);
      setAdbError('');
    } catch (error) {
      setAdbError(t('ui.55bacb6557e6') + errorText(error));
      setAdbMenuOpen(true);
    }
  };

  return { adbPortAccess, adbPublicKey, setAdbPublicKey, adbUserKey, adbKeyLoaded, newAdbKey, setNewAdbKey, privateKeyDownloaded, setPrivateKeyDownloaded, publicKeyDownloaded, setPublicKeyDownloaded, showCustomAdbKey, setShowCustomAdbKey, confirmKeyRotation, setConfirmKeyRotation, adbBusy, adbError, setAdbError, adbMenuOpen, setAdbMenuOpen, adbCopied, adbMenuRef, closeAdbMenu, loadAdbPublicKey, requestAdbPortAccess, createAdbUserKey, revokeAdbPortAccess, copyAdbCommand };
}
