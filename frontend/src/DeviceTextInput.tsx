import { useId, useLayoutEffect, useRef, useState } from 'react';
import { getDirection, t } from './i18n';
import { Icon } from './icons';
import './DeviceTextInput.css';

const TEXT_LIMIT = 1000;

export function DeviceTextInput({ active, canSend, onSend }: { active: boolean; canSend: boolean; onSend: (text: string) => boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const label = t('ui.8565dde56e60');
  const ready = canSend && text.length > 0 && text.length <= TEXT_LIMIT && !/[\r\n\0]/.test(text);

  useLayoutEffect(() => {
    const panel = popover.current, button = trigger.current;
    if (!panel || !button || !open) return;
    if (!active) { if (panel.matches(':popover-open')) panel.hidePopover(); return; }

    const viewport = window.visualViewport;
    const place = () => {
      const edge = 12, gap = 8;
      const leftEdge = (viewport?.offsetLeft ?? 0) + edge;
      const topEdge = (viewport?.offsetTop ?? 0) + edge;
      const width = (viewport?.width ?? window.innerWidth) - 2 * edge;
      const height = (viewport?.height ?? window.innerHeight) - 2 * edge;
      panel.style.maxWidth = `${width}px`;
      panel.style.maxHeight = `${height}px`;
      const rect = button.getBoundingClientRect();
      const right = leftEdge + width, bottom = topEdge + height;
      const beside = rect.right + gap + panel.offsetWidth <= right;
      const below = rect.bottom + gap;
      const top = beside ? rect.top : below + panel.offsetHeight <= bottom ? below : rect.top - gap - panel.offsetHeight;
      panel.style.left = `${beside ? rect.right + gap : Math.max(leftEdge, Math.min(rect.left, right - panel.offsetWidth))}px`;
      panel.style.top = `${Math.max(topEdge, Math.min(top, bottom - panel.offsetHeight))}px`;
      panel.dataset.positioned = '';
    };
    place();
    field.current?.focus({ preventScroll: true });
    const resize = new ResizeObserver(place);
    const workspace = button.closest('.workspace-grid');
    if (workspace) resize.observe(workspace);
    resize.observe(panel);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      delete panel.dataset.positioned;
      resize.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [active, open]);

  const close = () => {
    popover.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };

  return <>
    <button ref={trigger} type="button" className="device-control" title={label} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id}
      data-state={open ? 'enabled' : undefined} disabled={!canSend && !open}>
      <Icon name="keyboard" />
    </button>
    <div ref={popover} id={id} className="device-text-popover" popover="auto" role="dialog" dir={getDirection()} aria-labelledby={id + '-title'}
      onToggle={event => setOpen(event.newState === 'open')}
      onBlur={event => {
        const next = event.relatedTarget;
        if (next && next !== trigger.current && !event.currentTarget.contains(next) && event.currentTarget.matches(':popover-open')) event.currentTarget.hidePopover();
      }}>
      <header>
        <h2 id={id + '-title'}>{label}</h2>
        <button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={close}><Icon name="close" size={18} /></button>
      </header>
      <form onSubmit={event => {
        event.preventDefault();
        if (!ready || !onSend(text)) return;
        setText('');
        close();
      }}>
        <input ref={field} type="text" dir="auto" value={text} maxLength={TEXT_LIMIT} autoComplete="off" spellCheck={false}
          aria-label={t('ui.dd844df0eed4')} placeholder={t('ui.4215fafd1015')} onChange={event => setText(event.target.value)} />
        <button type="submit" className="button primary" disabled={!ready}>{t('ui.d3aa8669598a').trim()}</button>
      </form>
    </div>
  </>;
}
