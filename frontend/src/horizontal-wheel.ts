export function bindHorizontalWheel(element: HTMLDivElement | null) {
  if (!element) return;
  const onWheel = (event: WheelEvent) => {
    const { deltaMode, deltaX, deltaY } = event;
    if (!event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey ||
      Math.abs(deltaX) >= Math.abs(deltaY) || element.scrollWidth <= element.clientWidth ||
      (event.target instanceof Element && event.target.closest('[popover]'))) return;

    const unit = deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
    const direction = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    event.preventDefault();
    element.scrollBy({ left: deltaY * unit * direction, behavior: 'instant' });
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => element.removeEventListener('wheel', onWheel);
}
