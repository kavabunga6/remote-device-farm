import { useEffect, useRef } from 'react';

/** Close a native disclosure from outside or Escape without moving pointer focus. */
export function useDisclosureDismiss() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const element = ref.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const element = ref.current;
      if (event.key !== 'Escape' || !element?.open || !element.contains(document.activeElement)) return;
      event.preventDefault(); event.stopPropagation();
      element.open = false;
      element.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return ref;
}
