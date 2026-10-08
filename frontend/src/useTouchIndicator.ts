import { useCallback, useLayoutEffect, useRef } from 'react';

type PointerPosition = { pointerId: number; clientX: number; clientY: number; currentTarget: HTMLElement };
export type TouchIndicatorSnapshot = { x: number; y: number; radiusX: number; radiusY: number };
const TAP_HOLD_MS = 180;

// A local fallback for transports that do not render Android's native touch indicator.
// The same snapshot is drawn in the viewer and composed into PNG/WebM captures.
export function useTouchIndicator(sessionId: string, active: boolean) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const snapshot = useRef<TouchIndicatorSnapshot | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const preference = useRef({ sessionId, enabled: false });
  const pointerId = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  if (preference.current.sessionId !== sessionId) preference.current = { sessionId, enabled: false };

  const clear = useCallback(() => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
    pointerId.current = null;
    snapshot.current = null;
    if (markerRef.current) markerRef.current.hidden = true;
  }, []);
  useLayoutEffect(() => { clear(); return clear; }, [sessionId, active, clear]);

  const setEnabled = useCallback((enabled: boolean) => {
    // A completed environment request from another session must not affect this viewer.
    if (preference.current.sessionId !== sessionId) return;
    preference.current.enabled = enabled;
    if (!enabled) clear();
  }, [sessionId, clear]);

  const position = (event: PointerPosition) => {
    const marker = markerRef.current;
    if (!marker || !activeRef.current || !preference.current.enabled) return;
    const target = event.currentTarget;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const x = clamp((event.clientX - bounds.left) / bounds.width);
    const y = clamp((event.clientY - bounds.top) / bounds.height);
    const markerStyle = getComputedStyle(marker);
    snapshot.current = { x, y, radiusX: parseFloat(markerStyle.width) / (2 * target.clientWidth), radiusY: parseFloat(markerStyle.height) / (2 * target.clientHeight) };
    marker.style.left = x * 100 + '%';
    marker.style.top = y * 100 + '%';
    marker.hidden = false;
  };
  const getSnapshot = useCallback(() => activeRef.current && preference.current.enabled ? snapshot.current : null, []);
  return {
    markerRef, setEnabled, clear, getSnapshot,
    down(event: PointerPosition) {
      if (!activeRef.current || !preference.current.enabled) return;
      clear();
      pointerId.current = event.pointerId;
      position(event);
    },
    move(event: PointerPosition) { if (pointerId.current === event.pointerId) position(event); },
    end(event: PointerPosition) {
      if (pointerId.current !== event.pointerId) return;
      position(event);
      pointerId.current = null;
      // Keep a quick tap visible for several capture frames; Android input is sent immediately.
      hideTimer.current = window.setTimeout(clear, TAP_HOLD_MS);
    },
    cancel(event: Pick<PointerPosition, 'pointerId'>) { if (pointerId.current === event.pointerId) clear(); },
  };
}
