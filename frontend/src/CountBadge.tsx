import { TranslatedText } from './TranslatedText';
/** A labelled counter: a muted caption and a bold number in one pill ("Всего 2", "Найдено 1 из 2"). */
export function CountBadge({ label, value, total, title }: { label: string; value: number; total?: number; title?: string }) {
  return <span className="count-badge" title={title}>
    <span className="count-badge-label">{label}</span>
    <span className="count-badge-value">{value}{total !== undefined && total !== value && <span className="count-badge-total"><TranslatedText message="copy.CountBadge.c552c01a" values={{ p0: total }} /></span>}</span>
  </span>;
}
