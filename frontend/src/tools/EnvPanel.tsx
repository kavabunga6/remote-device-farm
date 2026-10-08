import { localizeText, t } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CITIES, NETWORK_PRESETS, PACKAGE_RE, PROXY_HOST_RE, getTimeZones, applyEnv, loadEnv } from '../env-api';
import type { EnvOp, EnvState } from '../env-api';
import { Icon } from '../icons';
import '../Env.css';
import { useNotifications } from '../notifications';

type Status = { kind: 'busy'; text: string } | undefined;
const PERMISSIONS = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.READ_CONTACTS', 'android.permission.POST_NOTIFICATIONS', 'android.permission.READ_EXTERNAL_STORAGE'];
const ERROR_TITLES: Record<EnvOp, string> = {
  get proxy() { return t('ui.fa46012c555a'); }, get network() { return t('ui.eea79795f97a'); }, get geo() { return t('ui.072b39f37206'); },
  get animations() { return t('ui.25e623287994'); }, get show_touches() { return t('ui.643ba7cb48f7'); }, get pointer_location() { return t('ui.41f53da066fc'); },
  get display_density() { return t('ui.e9a1527b2ab1'); }, get display_size() { return t('ui.3f678b3904e9'); },
  get battery() { return t('ui.9522389e8280'); }, get timezone() { return t('ui.b911150a02c4'); },
  get deeplink() { return t('ui.106eb9493d09'); }, get app_clear() { return t('ui.b46072c9c5c4'); }, get app_stop() { return t('ui.a2c154cdef4b'); },
  get app_grant() { return t('ui.f2646e531887'); }, get app_revoke() { return t('ui.e17f13fe660d'); },
  get dark_mode() { return t('ui.7aac0c2b1981'); }, get font_scale() { return t('ui.914150be90e4'); },
};

function Card({ title, description, hint, status, children, className = '', initialOpen = false }: {
  title: string; description: string; hint?: string; status?: Status; children: ReactNode; className?: string; initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return <details className={'env-card ' + className} open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-busy={status?.kind === 'busy'}>
    <summary><span className="env-card-heading"><strong>{title}</strong><span title={description}>{description}</span></span>
      {status && <span className="env-pending" role="status"><span className="mini-spinner" />{status.text}</span>}
      <Icon name="chevronDown" size={18} />
    </summary>
    <div className="env-card-body">
      {hint && <p className="env-hint">{hint}</p>}
      {children}
    </div>
  </details>;
}

// Device environment: network conditions, location, appearance, device state, links, app helpers.
export function EnvPanel({ sessionId, active, running, readForViewer = false, onShowTouchesChange, nativeTouches = false }: {
  sessionId: string; active: boolean; running: boolean; readForViewer?: boolean; onShowTouchesChange?: (enabled: boolean) => void; nativeTouches?: boolean;
}) {
  const { notify, notifyError } = useNotifications();
  const [env, setEnv] = useState<EnvState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [network, setNetwork] = useState<string | null>(null);
  const [networkDraft, setNetworkDraft] = useState('full');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('8080');
  const [place, setPlace] = useState<string | null>(null);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [density, setDensity] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [battery, setBattery] = useState(100);
  const [zone, setZone] = useState('UTC');
  const [uri, setUri] = useState('');
  const [pkg, setPkg] = useState('');
  const [permission, setPermission] = useState(PERMISSIONS[0]!);
  const loaded = useRef<string | null>(null);
  const readVersion = useRef(0);
  const loadedSession = useRef<string | null>(null);
  const activeSession = useRef<string | null>(sessionId);
  useEffect(() => {
    activeSession.current = sessionId;
    setEnv(null);
    setStatus({});
    return () => { activeSession.current = null; readVersion.current++; loaded.current = null; };
  }, [sessionId]);

  const refresh = useCallback(async (reportError = active) => {
    if (activeSession.current !== sessionId) return null;
    const version = ++readVersion.current;
    setLoading(true);
    try {
      const next = await loadEnv(sessionId);
      if (activeSession.current !== sessionId) return null;
      // A newer read owns the UI; this response still verifies the action that requested it.
      if (version !== readVersion.current) return next;
      loadedSession.current = sessionId;
      loaded.current = sessionId;
      setEnv(next);
      setProxyHost(next.proxy?.host ?? '');
      setProxyPort(next.proxy?.enabled ? String(next.proxy.port) : '8080');
      setLoadError('');
      if (next.battery) setBattery(next.battery.level);
      if (next.timezone && getTimeZones().some(z => z.id === next.timezone)) setZone(next.timezone);
      return next;
    } catch (error) {
      if (version !== readVersion.current) return null;
      setLoadError(t('ui.20e49fdb6cd9'));
      if (reportError) notifyError(t('ui.f4567e8c5e3e'), error);
      return null;
    } finally { if (version === readVersion.current) setLoading(false); }
  }, [sessionId, active, notifyError]);

  useEffect(() => {
    if (!running) { loaded.current = null; return; }
    if (!(active || readForViewer) || loaded.current === sessionId) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const read = async () => {
      if (cancelled || loaded.current === sessionId) return;
      const next = await refresh(false);
      if (cancelled || next || activeSession.current !== sessionId) return;
      // A transient startup/ADB read must not leave the viewer's touch preference disabled forever.
      // Retry only this initial load, without repeated notifications or an unbounded poll.
      if (++attempts < 3) timer = window.setTimeout(() => void read(), attempts === 1 ? 1000 : 3000);
    };
    // Let an immediately cancelled setup (including StrictMode) exit before requesting ADB.
    queueMicrotask(() => void read());
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [active, readForViewer, running, refresh, sessionId]);

  useEffect(() => {
    if (loadedSession.current === sessionId && env?.showTouches != null) onShowTouchesChange?.(env.showTouches);
  }, [env?.showTouches, onShowTouchesChange, sessionId]);

  const run = async (key: string, op: EnvOp, params: Record<string, string | number | boolean>, done: string,
                     options: { reload?: boolean; onOk?: (next: EnvState | null) => void; verify?: (next: EnvState) => boolean } = {}) => {
    setStatus(s => ({ ...s, [key]: { kind: 'busy', text: t('ui.b001f5d8019b') } }));
    try {
      await applyEnv(sessionId, op, params);
      if (activeSession.current !== sessionId) return;
      const next = options.reload !== false ? await refresh(false) : null;
      if (activeSession.current !== sessionId) return;
      if (options.verify && (!next || !options.verify(next))) {
        throw new Error(next ? t('ui.5afc15d57400') : t('ui.2237c912e6b7'));
      }
      options.onOk?.(next);
      setStatus(s => ({ ...s, [key]: undefined }));
      notify({ kind: 'success', title: done, key: 'env:' + sessionId + ':' + key });
    } catch (error) {
      if (activeSession.current !== sessionId) return;
      setStatus(s => ({ ...s, [key]: undefined }));
      notifyError(ERROR_TITLES[op], error);
    }
  };

  const commitBattery = () => {
    if (!running || status.device?.kind === 'busy' || battery === env?.battery?.level) return;
    void run('device', 'battery', { level: battery }, t('ui.5888c6fa90db') + battery + '%');
  };
  const busy = (key: string) => status[key]?.kind === 'busy';
  const off = !running;
  const latNum = Number(lat.replace(',', '.'));
  const lonNum = Number(lon.replace(',', '.'));
  const geoValid = lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(latNum) && Number.isFinite(lonNum) &&
    Math.abs(latNum) <= 90 && Math.abs(lonNum) <= 180;
  const proxyHostValid = proxyHost.length > 0 && proxyHost.length <= 253 && PROXY_HOST_RE.test(proxyHost);
  const proxyPortValid = /^\d{1,5}$/.test(proxyPort) && Number(proxyPort) >= 1 && Number(proxyPort) <= 65535;
  const proxyValid = proxyHostValid && proxyPortValid;
  const proxyDisabled = off || busy('proxy') || loading || !env;
  const pkgValid = PACKAGE_RE.test(pkg);
  const currentDensity = env?.density?.override ?? env?.density?.physical;
  const currentSize = env?.size?.override ?? env?.size?.physical;
  useEffect(() => { setDensity(currentDensity == null ? '' : String(currentDensity)); }, [currentDensity]);
  useEffect(() => {
    const [w = '', h = ''] = currentSize?.split('x') ?? [];
    setWidth(w); setHeight(h);
  }, [currentSize]);
  const densityValid = /^\d+$/.test(density) && Number(density) >= 120 && Number(density) <= 640;
  const sizeValid = [width, height].every(value => /^\d+$/.test(value) && Number(value) >= 320 && Number(value) <= 4096);
  const lookDisabled = off || busy('look') || loading || !env;


  return <div className="env-panel" hidden={!active}>
    <div className="env-head">
      <div><h2>{t('ui.d606a9df2b84')}</h2><p>{t('ui.ad4afc27d623')}</p></div>
      <button type="button" className="button small" onClick={() => void refresh(true)} disabled={off || loading}><Icon name="refresh" size={16} />{loading ? t('ui.351273476c20') : t('ui.603e460bf59c')}</button>
    </div>
    {off && <p className="env-note">{t('ui.0d5380a4cdb5')}</p>}
    {loadError && <p className="env-note" role="status">{localizeText(loadError)}</p>}

    <Card title={t('ui.26b855cc1660')} description={t('ui.9d4f6e426b84')} className="env-app" initialOpen status={status.app}>
      <div className="env-row env-app-main">
        <label>{t('ui.d5cc514f4bbb')}<input value={pkg} onChange={e => setPkg(e.target.value.trim())} placeholder={t('ui.8a464e05bf03')} maxLength={255} disabled={off} spellCheck={false}
          aria-invalid={pkg !== '' && !pkgValid} /></label>
        <div className="env-chips">
          <button type="button" className="button outline small" disabled={off || !pkgValid || busy('app')}
            onClick={() => void run('app', 'app_stop', { package: pkg }, t('ui.1afb70e488c7'), { reload: false })}>{t('ui.3396400da0c4')}</button>
          <button type="button" className="button small danger-outline" disabled={off || !pkgValid || busy('app')}
            onClick={() => { if (window.confirm(t('ui.961a05e6dac1') + pkg + '?')) void run('app', 'app_clear', { package: pkg }, t('ui.e70084d8c3da'), { reload: false }); }}>{t('ui.cb1099827e15')}</button>
        </div>
      </div>
      {pkg !== '' && !pkgValid && <p className="env-validation" role="status">{t('ui.3b36880a92a6')}</p>}
      <div className="env-row">
        <label>{t('ui.adc3b01f3c15')}<input list="env-permissions" value={permission} onChange={e => setPermission(e.target.value.trim())} maxLength={255} disabled={off} spellCheck={false} /></label>
        <datalist id="env-permissions">{PERMISSIONS.map(p => <option key={p} value={p} />)}</datalist>
        <button type="button" className="button small" disabled={off || !pkgValid || !PACKAGE_RE.test(permission) || busy('app')}
          onClick={() => void run('app', 'app_grant', { package: pkg, permission }, t('ui.1aebe5e15fb4'), { reload: false })}>{t('ui.5bf4dc29792c')}</button>
        <button type="button" className="button small" disabled={off || !pkgValid || !PACKAGE_RE.test(permission) || busy('app')}
          onClick={() => void run('app', 'app_revoke', { package: pkg, permission }, t('ui.1f9f592256e8'), { reload: false })}>{t('ui.b66927e0fc8e')}</button>
      </div>
    </Card>

    <Card title={t('ui.f4cb2c0e2410')} description={t('ui.76cdedae7f1b')} status={status.link}>
      <form className="env-row" onSubmit={e => { e.preventDefault(); if (off || !uri.trim() || busy('link')) return; void run('link', 'deeplink', { uri: uri.trim() }, t('ui.e65cd421a8d5'), { reload: false }); }}>
        <label>{t('ui.da82e80563d7')}<input value={uri} onChange={e => setUri(e.target.value)} placeholder={t('ui.58b28678e8be')} maxLength={2000} disabled={off} spellCheck={false} /></label>
        <button type="submit" className="button primary small" disabled={off || !uri.trim() || busy('link')}>{t('ui.ea1f40824607')}</button>
      </form>
    </Card>

    <Card title={t('ui.c062341615dc')} description={t('ui.ecb46640e3ac')} className="env-appearance" status={status.look}>
      <div className="env-display-toggles">
        <label className="env-switch"><input type="checkbox" role="switch" checked={env?.animations === false} disabled={lookDisabled}
          onChange={e => { const enabled = !e.target.checked; void run('look', 'animations', { enabled }, enabled ? t('ui.d29cc7371ca3') : t('ui.6cbfed37ef21'), { verify: next => next.animations === enabled }); }} />
          <span>{t('ui.dfdd3f58ad1f')}</span></label>
        <label className="env-switch"><input type="checkbox" role="switch" checked={env?.showTouches === true} disabled={lookDisabled}
          onChange={e => { const enabled = e.target.checked; void run('look', 'show_touches', { enabled }, t('ui.32f38bcadf1b') + (enabled ? t('ui.2923588c6533') : t('ui.b2a25ae548d2')), { verify: next => next.showTouches === enabled }); }} />
          <span>{t('ui.89c75eef0d0e')}</span></label>
        <label className="env-switch"><input type="checkbox" role="switch" checked={env?.pointerLocation === true} disabled={lookDisabled}
          onChange={e => { const enabled = e.target.checked; void run('look', 'pointer_location', { enabled }, t('ui.94e3ac9fa4c8') + (enabled ? t('ui.2923588c6533') : t('ui.b2a25ae548d2')), { verify: next => next.pointerLocation === enabled }); }} />
          <span>{t('ui.e4a493152c39')}</span></label>
      </div>
      <p className="env-hint env-touch-hint">{nativeTouches ? t('ui.3713f923b8a2') : t('ui.10e848ce6be5')}</p>
      <div className="env-display-settings">
        <form className="env-display-row" aria-label={t('ui.f89b0906a995')} onSubmit={e => {
          e.preventDefault();
          if (lookDisabled || !densityValid) return;
          void run('look', 'display_density', { dpi: Number(density) }, t('ui.e72c989c7574') + density + ' dpi', { verify: next => (next.density?.override ?? next.density?.physical) === Number(density) });
        }}>
          <label htmlFor="env-density">{t('ui.1fdda81c6144')}</label>
          <div className="env-display-inputs">
            <input id="env-density" type="number" inputMode="numeric" min={120} max={640} step={1} value={density} disabled={lookDisabled} required
              aria-label={t('ui.db74349be272')} aria-describedby="env-density-default" onChange={e => setDensity(e.target.value)} />
            <span>{t('ui.a80ad1fef638')}</span>
          </div>
          <button type="submit" className="button outline env-display-action" aria-label={t('ui.d55117e36037')} title={t('ui.d55117e36037')} disabled={lookDisabled || !densityValid || Number(density) === currentDensity}><Icon name="check" size={16} /></button>
          <button type="button" className="button outline env-display-action" aria-label={t('ui.942d6415f189')} title={t('ui.942d6415f189')} disabled={lookDisabled}
            onClick={() => void run('look', 'display_density', { reset: true }, t('ui.1c1b9e5bc0a8'), { verify: next => next.density != null && next.density.override == null, onOk: next => setDensity(String(next!.density!.physical)) })}><Icon name="refresh" size={16} /></button>
          <small id="env-density-default">{t('ui.d177bbd879be')}{env?.density ? env.density.physical + ' dpi' : '—'} · 120–640</small>
        </form>
        <form className="env-display-row" aria-label={t('ui.1bdcebcf1040')} onSubmit={e => {
          e.preventDefault();
          if (lookDisabled || !sizeValid) return;
          void run('look', 'display_size', { width: Number(width), height: Number(height) }, t('ui.8192fdb8cd0a', { p0: width, p1: height }), { verify: next => (next.size?.override ?? next.size?.physical) === `${Number(width)}x${Number(height)}` });
        }}>
          <span className="env-display-label">{t('ui.adc3b01f3c15')}</span>
          <div className="env-display-inputs">
            <input type="number" inputMode="numeric" min={320} max={4096} step={1} value={width} disabled={lookDisabled} required
              aria-label={t('ui.d27136b2c930')} aria-describedby="env-size-default" onChange={e => setWidth(e.target.value)} />
            <span aria-hidden="true">×</span>
            <input type="number" inputMode="numeric" min={320} max={4096} step={1} value={height} disabled={lookDisabled} required
              aria-label={t('ui.0df2438c45e9')} aria-describedby="env-size-default" onChange={e => setHeight(e.target.value)} />
            <span>{t('ui.6ee2cc105a67')}</span>
          </div>
          <button type="submit" className="button outline env-display-action" aria-label={t('ui.212fb49f41ae')} title={t('ui.212fb49f41ae')} disabled={lookDisabled || !sizeValid || `${Number(width)}x${Number(height)}` === currentSize}><Icon name="check" size={16} /></button>
          <button type="button" className="button outline env-display-action" aria-label={t('ui.9225e3466e24')} title={t('ui.9225e3466e24')} disabled={lookDisabled}
            onClick={() => void run('look', 'display_size', { reset: true }, t('ui.c3445acf284c'), { verify: next => next.size != null && next.size.override == null, onOk: next => { const [w, h] = next!.size!.physical.split('x'); setWidth(w!); setHeight(h!); } })}><Icon name="refresh" size={16} /></button>
          <small id="env-size-default">{t('ui.d177bbd879be')}{env?.size ? env.size.physical.replace('x', '×') + ' px' : '—'} · 320–4096</small>
        </form>
      </div>
    </Card>

    <Card title={t('ui.8006cb7a4968')} description={network ? NETWORK_PRESETS.find(p => p.id === network)?.label || t('ui.c89c773e603d') : t('ui.e5df65da8950')} status={status.network ?? status.proxy}>
      <form className="env-row env-select-row" onSubmit={event => {
        event.preventDefault();
        if (off || busy('network')) return;
        const preset = NETWORK_PRESETS.find(p => p.id === networkDraft)!;
        void run('network', 'network', { profile: preset.id }, t('ui.9ae609ae2922') + preset.label, { reload: false, onOk: () => setNetwork(preset.id) });
      }}>
        <label>{t('ui.0021f16647e7')}<select value={networkDraft} disabled={off || busy('network')} onChange={event => setNetworkDraft(event.target.value)}>
          {NETWORK_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select></label>
        <button type="submit" className="button primary small" disabled={off || busy('network') || network === networkDraft}>{t('ui.e15f960d93eb')}</button>
      </form>
      <p className="env-hint">{t('ui.ebcf7730487a')}</p>
      <section className="env-proxy" aria-labelledby="env-proxy-title">
        <div className="env-proxy-heading"><h3 id="env-proxy-title">{t('ui.101dbc6ce5fb')}</h3>
          <p className="env-hint">{t('ui.3363378664d9')}</p>
        </div>
        <div className="env-proxy-state" data-state={env?.proxy ? env.proxy.enabled ? 'enabled' : 'disabled' : 'unknown'} role="status" aria-live="polite" aria-busy={loading || busy('proxy')}>
          <Icon name={env?.proxy?.enabled ? 'check' : env?.proxy ? 'wifi' : 'info'} size={20} />
          <div><strong>{env?.proxy ? env.proxy.enabled ? t('ui.cc4ab66b2806') : t('ui.5a69c2dba9fb') : loading ? t('ui.7808adc50f5f') : t('ui.fc3f0155261c')}</strong>
            <span>{env?.proxy ? env.proxy.enabled ? `${env.proxy.host}:${env.proxy.port}` : t('ui.110b70c8a327') : t('ui.cc02655b5914')}</span></div>
          {busy('proxy') && <span className="env-proxy-pending"><span className="mini-spinner" />{t('ui.b001f5d8019b')}</span>}
        </div>
        <form className="env-proxy-form" onSubmit={event => {
          event.preventDefault();
          if (proxyDisabled || !proxyValid) return;
          const host = proxyHost.toLowerCase(), port = Number(proxyPort);
          void run('proxy', 'proxy', { host, port }, t('ui.a07a3d8d17a5') + host + ':' + port,
            { verify: next => next.proxy?.enabled === true && next.proxy.host === host && next.proxy.port === port });
        }}>
          <div className="env-proxy-fields">
            <label>{t('ui.ef480d15ab4e')}<input value={proxyHost} onChange={event => setProxyHost(event.target.value)} placeholder={t('ui.805ebf201c52')} maxLength={253}
              disabled={proxyDisabled} spellCheck={false} autoCapitalize="none" aria-invalid={proxyHost !== '' && !proxyHostValid} aria-describedby="proxy-host-hint" /></label>
            <label>{t('ui.90947197f86b')}<input value={proxyPort} onChange={event => setProxyPort(event.target.value)} inputMode="numeric" placeholder={t('ui.6c237681e709')} maxLength={5}
              disabled={proxyDisabled} aria-invalid={!proxyPortValid} aria-describedby="proxy-port-hint" /></label>
            <small id="proxy-host-hint">{t('ui.aebd66c4aed4')}</small>
            <small id="proxy-port-hint">1–65535</small>
          </div>
          <div className="env-proxy-actions">
            <button type="submit" className="button primary small" disabled={proxyDisabled || !proxyValid}>{t('ui.2c129a7af5ce')}</button>
            <button type="button" className="button outline small" disabled={proxyDisabled || env?.proxy?.enabled !== true}
              onClick={() => void run('proxy', 'proxy', { reset: true }, t('ui.5a69c2dba9fb'), { verify: next => next.proxy?.enabled === false })}>{t('ui.238f16120154')}</button>
          </div>
        </form>
        {proxyHost !== '' && !proxyValid && <p className="env-validation" role="status">{t('ui.8674af6d3627')}</p>}
      </section>
    </Card>

    <Card title={t('ui.53293ec53673')} description={t('ui.bfd9956229e6')} status={status.geo}>
      <label className="env-field env-preset-field">{t('ui.8ad2e55cf858')}<select value={place ?? ''} disabled={off || busy('geo')} onChange={event => {
        const city = CITIES.find(c => c.id === event.target.value);
        setPlace(city?.id ?? null);
        if (city) { setLat(String(city.lat)); setLon(String(city.lon)); }
      }}>
        <option value="">{t('ui.2518177127ff')}</option>
        {CITIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select></label>
      <form className="env-row env-geo-row" onSubmit={event => {
        event.preventDefault();
        if (off || !geoValid || busy('geo')) return;
        void run('geo', 'geo', { lat: latNum, lon: lonNum }, t('ui.45563ec11ebe'), { reload: false });
      }}>
        <label>{t('ui.3dd6edf68bb7')}<input inputMode="decimal" value={lat} onChange={e => { setLat(e.target.value); setPlace(null); }} placeholder={t('ui.078ffdb5d72a')} disabled={off || busy('geo')} /></label>
        <label>{t('ui.fa282f8efb9e')}<input inputMode="decimal" value={lon} onChange={e => { setLon(e.target.value); setPlace(null); }} placeholder={t('ui.0d68d05a841f')} disabled={off || busy('geo')} /></label>
        <button type="submit" className="button primary small" disabled={off || !geoValid || busy('geo')}>{t('ui.4f4523064b74')}</button>
      </form>
      <p className="env-hint">{t('ui.524b6f05ddda')}</p>
    </Card>

    <Card title={t('ui.dba20ab53801')} description={t('ui.8556eee04c93')} status={status.device}>
      <div className="env-slider">
        <label htmlFor="env-battery">{t('ui.8991370b5b60')}<b>{battery}%</b></label>
        <input id="env-battery" type="range" min={0} max={100} step={1} value={battery} disabled={off || busy('device')}
          onChange={e => setBattery(Number(e.target.value))}
          onPointerUp={commitBattery}
          onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitBattery(); }} />
      </div>
      <div className="env-chips">
        {([['ac', t('ui.b2cc76171b06')], ['usb', t('ui.6865d2fc2b57')], ['none', t('ui.7a6f4ad871f4')]] as const).map(([id, label]) => <button key={id} type="button"
          className={'env-chip' + (env?.battery?.charging === id ? ' on' : '')} disabled={off || busy('device')}
          onClick={() => void run('device', 'battery', { charging: id }, label)}>{label}</button>)}
        <button type="button" className="env-chip" disabled={off || busy('device')} onClick={() => void run('device', 'battery', { reset: true }, t('ui.feb6a5d63265'))}>{t('ui.407f871778d3')}</button>
      </div>
      <div className="env-row">
        <label>{t('ui.ce2e24e73ac4')}<select value={zone} onChange={e => setZone(e.target.value)} disabled={off}>
          {getTimeZones().map(z => <option key={z.id} value={z.id}>{z.label}</option>)}</select></label>
        <button type="button" className="button primary small" disabled={off || busy('device')}
          onClick={() => void run('device', 'timezone', { zone }, t('ui.27a38e1d9176') + zone)}>{t('ui.e15f960d93eb')}</button>
      </div>
      {env?.timezone && <p className="env-hint">{t('ui.00216d98dc10')}{env.timezone}</p>}
    </Card>

  </div>;
}
