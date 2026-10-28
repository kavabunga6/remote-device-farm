import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { t } from '../i18n';

export function TrafficPopover({ label, icon, open, onOpenChange, children }: {
  label: string; icon: IconName; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popover = panel.current, button = trigger.current;
    if (!popover || !button) return;
    if (!open) { if (popover.matches(':popover-open')) popover.hidePopover(); return; }
    const place = () => {
      const rect = button.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 24);
      popover.style.width = width + 'px';
      popover.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
      popover.style.top = Math.min(rect.bottom + 6, Math.max(12, window.innerHeight - popover.offsetHeight - 12)) + 'px';
    };
    popover.showPopover(); place();
    popover.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    const popover = panel.current;
    const changed = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') onOpenChange(false); };
    popover?.addEventListener('toggle', changed);
    return () => popover?.removeEventListener('toggle', changed);
  }, [onOpenChange]);
  return <>
    <button ref={trigger} className="traffic-control traffic-popover-trigger" type="button" aria-label={label}
      title={label} aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
      <Icon name={icon} size={16}/><span>{label}</span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={label} className="traffic-popover" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpenChange(false); trigger.current?.focus(); }
    }}>
      <header><strong>{label}</strong><button type="button" className="traffic-popover-close" aria-label={t('ui.a7a4033657e8')}
        onClick={() => { onOpenChange(false); trigger.current?.focus(); }}><Icon name="close" size={16}/></button></header>
      {children}
    </div>
  </>;
}
