import { t } from './i18n';
import { Icon } from './icons';

export function Brand({ compact = false, tagline = true }: { compact?: boolean; tagline?: boolean }) {
  return <div className="brand"><span className="brand-mark"><Icon name="phone" size={19} /></span>{!compact && <span className="brand-name" dir="ltr">{t('ui.6ba0bdeccb42')}<span>{t('ui.3457b1617fe5')}</span>{tagline && <small dir="auto">{t('ui.ff6679c5bd1a')}</small>}</span>}</div>;
}

