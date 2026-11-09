import { getLocale } from '../i18n';

export function formatTime(value: string) {
  return new Date(value).toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function number(value: number | null, options?: Intl.NumberFormatOptions) {
  return value === null ? '—' : new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1, ...options }).format(value);
}

export function percent(value: number | null) {
  return number(value === null ? null : value / 100, { style: 'percent' });
}

export function bytes(value: number | null, rate = false) {
  if (value === null) return '—';
  const [size, unit] = value >= 1e9 ? [value / 1e9, 'gigabyte']
    : value >= 1e6 ? [value / 1e6, 'megabyte']
    : value >= 1e3 ? [value / 1e3, 'kilobyte'] : [value, 'byte'];
  return number(size, { style: 'unit', unit: rate ? unit + '-per-second' : unit });
}
