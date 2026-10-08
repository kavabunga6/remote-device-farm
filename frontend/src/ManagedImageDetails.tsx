import { t, type MessageKey } from './i18n';
import { Icon } from './icons';
import type { ManagedImage } from './image-management-api';

// Match the catalog's published API/version data; unknown API levels stay explicit.
const versions: Record<number, string> = { 21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17' };
const flavors: Record<string, MessageKey> = {
  default: 'images.flavor.aosp', google_apis: 'images.flavor.google', google_apis_playstore: 'images.flavor.play',
  aosp_atd: 'images.flavor.aospAtd', google_atd: 'images.flavor.googleAtd',
  'android-tv': 'images.flavor.tv', 'google-tv': 'images.flavor.googleTv',
  'android-wear': 'images.flavor.wear', 'android-wear-signed': 'images.flavor.wearPlay',
  'android-automotive': 'images.flavor.auto', 'android-automotive-playstore': 'images.flavor.autoPlay',
  'android-desktop': 'images.flavor.desktop',
};
export const imageKey = (item: ManagedImage) => item.digest ?? item.id!;
export function imageDisplay(item: ManagedImage) {
  const match = /^system-images;android-(\d+(?:\.\d+)?)(?:-ext(\d+))?;([^;]+);([^;]+)$/.exec(item.package ?? '');
  if (!match) return { name: item.package ?? t('images.unknown'), metadata: null, versionKey: null, android: null };
  const version = versions[Number(match[1].split('.')[0])];
  const android = version ? t('images.androidVersion', { p0: version }) : t('images.androidApi', { p0: match[1] });
  const flavor = flavors[match[3]] ? t(flavors[match[3]]) : match[3];
  return {
    name: android + ' · ' + flavor,
    versionKey: match[1].split('.')[0], android,
    metadata: [t('images.apiVersion', { p0: match[1] }), match[2] ? t('images.apiExtension', { p0: match[2] }) : null, match[4]].filter(Boolean).join(' · '),
  };
}

export function ManagedImageDetails({ item, onCopy }: { item: ManagedImage; onCopy: (value: string) => void }) {
  const display = imageDisplay(item), id = imageKey(item);
  return <div className="image-identity">
    <div className="image-name-line"><Icon name="layers" size={17} /><strong className="image-display-name">{display.name}</strong></div>
    <span className="image-metadata">{display.metadata ?? t('images.metadataMissing')}</span>
    <div className="image-identifier-line"><details className="image-details">
      <summary><code title={id}>{id.slice(0, 19)}…</code><Icon name="chevronDown" size={14} /><span className="sr-only">{t('images.technicalDetails')}</span></summary>
      <dl>
        {item.package && <><dt>{t('images.package')}</dt><dd><code>{item.package}</code></dd></>}
        <dt>{item.digest ? t('images.digest') : t('images.imageId')}</dt>
        <dd><code>{id}</code></dd>
        <dt>{t('images.tags')}</dt><dd>{item.tags.length ? item.tags.map(tag => <code key={tag}>{tag}</code>) : t('images.untagged')}</dd>
        {Boolean(item.digests?.length) && <><dt>{t('images.imageReferences')}</dt><dd>{item.digests!.map(value => <code key={value}>{value}</code>)}</dd></>}
      </dl>
    </details><button type="button" className="icon-button image-identifier-copy" title={t('images.copyIdentifier')} aria-label={t('images.copyIdentifier')} onClick={() => onCopy(id)}><Icon name="copy" size={14} /></button></div>
  </div>;
}

const reasons = new Set(['session', 'queue', 'prewarm', 'index', 'build', 'transfer', 'sharedRegistry', 'container', 'reference', 'foreignAlias']);
export const imageReason = (value: string) => t(('images.reason.' + (reasons.has(value) ? value : 'protected')) as MessageKey);
export function ManagedImageUsage({ item }: { item: ManagedImage }) {
  const profiles = item.uses.filter(use => use.kind === 'profile');
  const latest = item.uses.some(use => use.kind === 'catalog');
  const protectedImage = Boolean(item.blockers.length);
  return <div className="image-usage">
    <div className="image-status-line">
      <span className={'image-status ' + (protectedImage ? 'is-protected' : latest ? 'is-current' : item.uses.length ? 'is-linked' : 'is-unused')} title={protectedImage ? item.blockers.map(imageReason).join(' · ') : undefined}>
        {protectedImage ? <Icon name="shield" size={13} /> : latest ? <Icon name="check" size={13} /> : null}
        {protectedImage ? t('images.protected') : latest ? t('images.latest') : item.uses.length ? t('images.inUse') : t('images.unused')}
      </span>
      {protectedImage && latest && <span className="image-current-label">{t('images.latest')}</span>}
    </div>
    {profiles.length > 0 && <div className="image-profile-links">{profiles.map(profile => <a href={'#/admin/profiles?profile=' + encodeURIComponent(profile.id)} key={profile.id} title={profile.name}><Icon name="phone" size={13} /><span>{profile.name}</span></a>)}</div>}
    {protectedImage && <details className="image-protection-details"><summary>{t('images.protectionReasons')}<Icon name="chevronDown" size={13} /></summary><ul>{item.blockers.map(value => <li key={value}>{imageReason(value)}</li>)}</ul></details>}
  </div>;
}
