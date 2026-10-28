import { t, getLocale } from './i18n';
import { Icon } from './icons';
import type { ManagedImage } from './image-management-api';

type Usage = 'all' | 'unused' | 'protected';
export function ImageInventorySummary({ items, usage, onFilter, formatBytes }: {
  items: ManagedImage[]; usage: Usage; onFilter: (value: Usage) => void; formatBytes: (value: number) => string;
}) {
  const unused = items.filter(item => !item.uses.length && !item.blockers.length);
  const protectedCount = items.filter(item => item.blockers.length).length;
  const count = (value: number) => new Intl.NumberFormat(getLocale()).format(value);
  return <div className="image-inventory-summary" aria-label={t('images.summary.label')}>
    <div className="image-summary-item" title={t('images.sizeNote')}><Icon name="layers" size={14}/>
      <span>{t('images.summary.count', { p0: count(items.length) })}</span>
      <span>{t('images.size')}: <strong>{formatBytes(items.reduce((total, item) => total + item.sizeBytes, 0))}</strong></span>
    </div>
    <button type="button" className="image-summary-item" aria-pressed={usage === 'unused'} onClick={() => onFilter(usage === 'unused' ? 'all' : 'unused')}>
      <span>{t('images.filter.unused')}: <strong>{count(unused.length)}</strong></span>
      <span className="image-summary-hint">{formatBytes(unused.reduce((total, item) => total + item.sizeBytes, 0))}</span>
    </button>
    <button type="button" className="image-summary-item" title={t('images.summary.protectedHint')} aria-pressed={usage === 'protected'} onClick={() => onFilter(usage === 'protected' ? 'all' : 'protected')}>
      <Icon name="shield" size={13}/><span>{t('images.filter.protected')}: <strong>{count(protectedCount)}</strong></span>
    </button>
  </div>;
}
