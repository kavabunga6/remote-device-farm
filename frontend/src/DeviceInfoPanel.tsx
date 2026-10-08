import { getLanguage, getLocale, localizeText, t } from './i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DeviceInfo } from './api';
import { Icon } from './icons';
import './SessionTools.css';

type Row = [label: string, value: string | null | undefined, mono?: boolean, wide?: boolean];

function kb(value: number | null | undefined): string {
  if (value == null) return '—';
  const gb = value / 1024 / 1024;
  return gb >= 1 ? t('ui.38299421d537', { p0: gb.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t('ui.fb360df45f73', { p0: Math.round(value / 1024) });
}

function uptime(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400); const hours = Math.floor(total % 86400 / 3600); const minutes = Math.floor(total % 3600 / 60);
  return [days ? t('ui.3565112ade5a', { p0: days }) : '', hours || days ? t('ui.da307435c605', { p0: hours }) : '', t('ui.1febafe019db', { p0: minutes })].filter(Boolean).join(' ');
}

function dimensions(value: { width: number; height: number } | null | undefined): string | null {
  return value ? `${value.width} × ${value.height}` : null;
}

function date(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function sections(info: DeviceInfo): Array<{ title: string; rows: Row[] }> {
  const { device, android, display, system, graphics, session, profile } = info;
  const phone = [device.manufacturer, device.model].filter(Boolean).join(' ');
  return [
    { title: t('ui.dba20ab53801'), rows: [
      [t('ui.f3bdf7cce355'), phone || null], [t('ui.15a5e7fed210'), device.codename], [t('ui.18f132164568'), device.hardware],
      [t('ui.9fe78c578dee'), device.abi], [t('ui.fd67d2814c90'), device.abis.join(', ') || null, true], [t('ui.bb134e993025'), device.serial, true],
    ] },
    { title: t('ui.6d612a86bee4'), rows: [
      [t('ui.c39948923340'), android.release ? `Android ${android.release}${android.sdk ? ` (API ${android.sdk})` : ''}` : null],
      [t('ui.1355c5f657b2'), android.securityPatch], [t('ui.8c39bb691b95'), android.buildId, true], [t('ui.999ebfd21959'), android.buildType],
      [t('ui.c60b92f2c9a6'), android.debuggable ? t('ui.4b043d0b1605') : t('ui.1e4b68699013')], ['Root', android.rooted ? t('ui.0a7bfb95efdc') : t('ui.43e5ab70f691')],
      [t('ui.f72a213b2ad8'), android.fingerprint, true, true], [t('ui.18e0b764b5c2'), system.kernel, true], ['Chrome', info.chrome, true],
    ] },
    { title: t('ui.c062341615dc'), rows: [
      [t('ui.adc3b01f3c15'), dimensions(display.physical)], [t('ui.020705c8d579'), dimensions(display.override)],
      [t('ui.1fdda81c6144'), display.density ? `${display.density} dpi` : null],
      [t('ui.ed20074dee6d'), session.orientation === 'landscape' ? t('ui.d34652d24c11') : t('ui.38aa441113ac')],
      ['OpenGL ES', graphics.openGl], ['EGL', graphics.egl, true], ['Vulkan', graphics.vulkan, true],
    ] },
    { title: t('ui.6da215b1bdac'), rows: [
      [t('ui.0232a305412b'), uptime(system.uptimeSeconds)], [t('ui.ce2e24e73ac4'), system.timezone], [t('ui.5bd57038dbad'), system.locale],
      [t('ui.bcbea0c585e5'), session.networkEnabled ? t('ui.0b8162990567') : t('ui.5a577d905660')],
      [t('ui.4ce39839e417'), info.battery?.level != null ? `${info.battery.level}%${info.battery.status ? `, ${info.battery.status}` : ''}` : null],
      [t('ui.1312536ace6e'), info.network.addresses.map(item => `${item.interface} ${item.address}`).join(', ') || null, true],
    ] },
    ...(profile ? [{ title: t('ui.599412c70ba3'), rows: [
      [t('ui.359497aff53e'), profile.name], [t('ui.157705d4fc52'), profile.image, true, true],
      [t('ui.b0cedecc718e'), `${profile.cpu} CPU, ${profile.memoryMb >= 1024 ? t('ui.38299421d537', { p0: (profile.memoryMb / 1024).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t('ui.fb360df45f73', { p0: profile.memoryMb })}`],
      [t('ui.38866d6cad6b'), profile.guestCores || profile.guestMemoryMb ? `${profile.guestCores ?? '—'} CPU, ${profile.guestMemoryMb ? t('ui.fb360df45f73', { p0: profile.guestMemoryMb }) : '—'} RAM` : null],
      [t('ui.375e6c39df8d'), t('ui.38299421d537', { p0: profile.diskGb })], [t('ui.f8233ded1023'), profile.sdCardMb == null ? t('ui.53776f3f36a4') : profile.sdCardMb === 0 ? t('ui.5bd2e464d062') : t('ui.fb360df45f73', { p0: profile.sdCardMb })], [t('ui.f573c252a73d'), profile.gpuMode === 'nvidia' ? 'GPU' : t('ui.fc7ae8efe6e8')],
      [t('ui.8161094c8931'), profile.emulatorParams || null, true, true],
    ] as Row[] }] : []),
    { title: t('ui.f7aa03484689'), rows: [
      [t('ui.cf97a1c54988'), session.id, true], [t('ui.e77a383ee52d'), session.hostName], [t('ui.0a39fbc65169'), date(session.createdAt)], [t('ui.9e62692be036'), date(session.startedAt)],
    ] },
  ];
}

function asText(info: DeviceInfo): string {
  const lines: string[] = [];
  for (const section of sections(info)) {
    lines.push(`# ${section.title}`);
    for (const [label, value] of section.rows) if (value) lines.push(`${label}: ${value}`);
    lines.push('');
  }
  if (info.apps.length) { lines.push(t('ui.f363609539ca')); for (const app of info.apps) lines.push(`${app.package}${app.versionCode != null ? ` (${app.versionCode})` : ''}`); }
  return lines.join('\n');
}

function Meter({ label, used, total }: { label: string; used: number | null; total: number | null }) {
  if (used == null || total == null || total <= 0) return null;
  const percent = Math.min(100, Math.round(used / total * 100));
  return <div className="info-meter"><div><span>{label}</span><strong>{kb(used)} {t('ui.e029cc4b39ce')}{kb(total)}</strong></div><div className="info-meter-track" role="img" aria-label={t('ui.7f56d22bb8dc', { p0: label, p1: percent })}><span className={percent > 90 ? 'high' : ''} style={{ width: percent + '%' }} /></div></div>;
}

export function DeviceInfoPanel({ sessionId, active, running }: { sessionId: string; active: boolean; running: boolean }) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [appQuery, setAppQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setInfo(await api.deviceInfo(sessionId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('ui.de4745273a1f')); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { if (active && running && !info && !loading && !error) void load(); }, [active, running, info, loading, error, load]);

  const flash = (key: string) => { setCopied(key); window.setTimeout(() => setCopied(current => current === key ? '' : current), 1400); };
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); flash(key); } catch { setError(t('ui.235d113a9143')); }
  };
  const groups = useMemo(() => info ? sections(info) : [], [info, getLanguage()]);
  const apps = useMemo(() => (info?.apps ?? []).filter(app => app.package.toLowerCase().includes(appQuery.trim().toLowerCase())), [info, appQuery, getLanguage()]);

  return <div className="info-panel" hidden={!active}>
    <div className="log-head info-head">
      <div className="log-title"><h2>{t('ui.1ad70005bb4e')}</h2><p>{t('ui.488d1427969c')}</p>{info && <span className="info-updated">{t('ui.d3a75ac5ad85')}{date(info.collectedAt)}</span>}</div>
      <div className="log-actions">
        <button type="button" className="icon-button" onClick={() => info && void copy('all', asText(info))} disabled={!info} title={t('ui.a976fab63b3d')} aria-label={t('ui.a976fab63b3d')}><Icon name={copied === 'all' ? 'check' : 'copy'} size={17} /></button>
        <button type="button" className="icon-button" onClick={() => void load()} disabled={loading || !running} title={t('ui.603e460bf59c')} aria-label={t('ui.5ecad382f1c6')}><Icon name="refresh" size={17} /></button>
      </div>
    </div>
    {!running && <div className="log-empty">{t('ui.57bb55735ad7')}</div>}
    {running && loading && !info && <div className="log-empty">{t('ui.ed04834b2fe1')}</div>}
    {error && <div className="log-error" role="alert"><Icon name="alert" size={15} />{localizeText(error)}</div>}
    {info && <div className="info-body">
      <div className="info-meters">
        <Meter label={t('ui.c30781d428d6')} used={info.memory.totalKb != null && info.memory.availableKb != null ? info.memory.totalKb - info.memory.availableKb : null} total={info.memory.totalKb} />
        <Meter label={t('ui.62eb23dd3126')} used={info.storage?.usedKb ?? null} total={info.storage?.totalKb ?? null} />
      </div>
      {groups.map(section => <section key={section.title} className="info-group">
        <h3>{section.title}</h3>
        <dl>{section.rows.filter(row => row[1]).map(([label, value, mono, wide]) => <div key={label} className={'info-row' + (wide ? ' info-row-wide' : '')}>
          <dt>{label}</dt>
          <dd className={mono ? 'mono' : ''}><button type="button" onClick={() => void copy(section.title + label, String(value))} title={t('ui.5a76c7edb54d')}>{value}</button>{copied === section.title + label && <span className="info-copied">{t('ui.d2d08c715ee6')}</span>}</dd>
        </div>)}</dl>
      </section>)}
      <section className="info-group info-app-section">
        <h3 className="heading-with-count"><span>{t('ui.2eb2675b05e1')}</span><span className="count-pill">{info.apps.length}</span></h3>
        {info.apps.length > 6 && <input className="info-app-search" value={appQuery} onChange={event => setAppQuery(event.target.value)} placeholder={t('ui.0bf8c8268833')} aria-label={t('ui.18b756fb08e6')} />}
        {apps.length ? <ul className="info-apps">{apps.map(app => <li key={app.package}><button type="button" className="mono" onClick={() => void copy('app' + app.package, app.package)} title={t('ui.1e6cd8c6da05')}>{app.package}</button><span>{copied === 'app' + app.package ? t('ui.d2d08c715ee6') : app.versionCode != null ? t('ui.7c2e192bf8fa', { p0: app.versionCode }) : ''}</span></li>)}</ul>
          : <p className="info-none">{info.apps.length ? t('ui.6bd686a24526') : t('ui.929cebc4b55c')}</p>}
      </section>
    </div>}
  </div>;
}
