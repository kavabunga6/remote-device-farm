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
    <div className="image-summary-item"><Icon name="layers" size={20} /><dl>
      <dt>{t('images.size')}</dt><dd><strong>{formatBytes(items.reduce((total, item) => total + item.sizeBytes, 0))}</strong><span>{t('images.summary.count', { p0: count(items.length) })}</span></dd>
    </dl></div>
    <button type="button" className="image-summary-item" aria-pressed={usage === 'unused'} onClick={() => onFilter(usage === 'unused' ? 'all' : 'unused')}><Icon name="trash" size={20} /><span>
      <span className="image-summary-label">{t('images.filter.unused')}</span><strong>{count(unused.length)}</strong><span className="image-summary-hint">{t('images.summary.unusedSize', { p0: formatBytes(unused.reduce((total, item) => total + item.sizeBytes, 0)) })}</span>
    </span></button>
    <button type="button" className="image-summary-item" aria-pressed={usage === 'protected'} onClick={() => onFilter(usage === 'protected' ? 'all' : 'protected')}><Icon name="shield" size={20} /><span>
      <span className="image-summary-label">{t('images.filter.protected')}</span><strong>{count(protectedCount)}</strong><span className="image-summary-hint">{t('images.summary.protectedHint')}</span>
    </span></button>
  </div>;
}
