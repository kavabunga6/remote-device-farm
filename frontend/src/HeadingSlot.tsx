import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Renders children inside the shared page header action area; falls back to in place. */
export function HeadingSlot({ slot, children }: { slot: 'actions'; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setTarget(document.getElementById('page-heading-' + slot)); }, [slot]);
  return target ? createPortal(children, target) : <>{children}</>;
}
