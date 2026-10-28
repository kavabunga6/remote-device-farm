import { t, type MessageKey } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { generatePassword } from './password-generator';
import './PasswordTools.css';

type Props = {
  value: string;
  visible: boolean;
  disabled?: boolean;
  onVisibleChange: (visible: boolean) => void;
  onGenerate: (password: string) => void;
};

export function PasswordTools({ value, visible, disabled = false, onVisibleChange, onGenerate }: Props) {
  const [feedback, setFeedback] = useState<MessageKey | null>(null);
  const [failed, setFailed] = useState(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  useEffect(() => { setFeedback(null); setFailed(false); }, [value]);
  const generate = () => {
    try { onGenerate(generatePassword()); }
    catch { setFailed(true); setFeedback('ui.6ff4248002d0'); }
  };
  const copy = async () => {
    setFeedback(null); setFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      if (latestValue.current === value) setFeedback('ui.7ca5c41ee61e');
    } catch {
      if (latestValue.current === value) {
        setFailed(true); setFeedback('ui.35e2a13cdebc');
      }
    }
  };
  return <div className="password-tools">
    <div className="password-tools-actions" role="group" aria-label={t('ui.246335921945')}>
      <button type="button" className="button outline small password-generate" onClick={generate} disabled={disabled} title={t('ui.fbbc33881dc9')}><Icon name="refresh" size={16} />{t('ui.ab5e1191a766')}</button>
      <button type="button" className="icon-button" onClick={() => onVisibleChange(!visible)} disabled={disabled || !value} aria-pressed={visible} aria-label={visible ? t('ui.6ea8f406d34f') : t('ui.4aa1465f1f84')} title={visible ? t('ui.6ea8f406d34f') : t('ui.4aa1465f1f84')}><Icon name={visible ? 'eyeOff' : 'eye'} size={18} /></button>
      <button type="button" className="icon-button" onClick={() => void copy()} disabled={disabled || !value} aria-label={t('ui.092e2a0bfe37')} title={t('ui.092e2a0bfe37')}><Icon name={feedback === 'ui.7ca5c41ee61e' ? 'check' : 'copy'} size={18} /></button>
    </div>
    {feedback && <p className={'password-tools-feedback' + (failed ? ' error' : '')} role={failed ? 'alert' : 'status'}>{t(feedback)}</p>}
  </div>;
}
