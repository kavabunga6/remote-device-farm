import type { SVGProps } from 'react';

export type IconName =
  | 'globe' | 'pencil' | 'eye' | 'eyeOff' | 'grid' | 'phone' | 'server' | 'shield' | 'plus' | 'minus' | 'arrowRight' | 'chevronLeft'
  | 'chevronDown' | 'power' | 'rotate' | 'volume' | 'volumeOff' | 'upload' | 'terminal' | 'more'
  | 'sliders' | 'expand' | 'back' | 'home' | 'recent' | 'play' | 'refresh' | 'close' | 'check' | 'alert'
  | 'user' | 'logout' | 'keyboard' | 'copy' | 'download' | 'bolt' | 'search' | 'menu' | 'info' | 'wifi' | 'wifiOff' | 'key' | 'camera' | 'record' | 'stop' | 'trash' | 'arrowDown' | 'arrowUp' | 'pause' | 'list' | 'star' | 'slots' | 'layers';

const paths: Record<IconName, React.ReactNode> = {
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/></>,
  sliders: <><path d="M3 6h6m4 0h8M3 12h11m4 0h3M3 18h3m4 0h11"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/></>,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>,
  eyeOff: <><path d="m3 3 18 18M6.5 6.5C3.5 8.5 2 12 2 12s3.5 7 10 7c2 0 3.7-.6 5.2-1.5M10 5.2c.6-.1 1.3-.2 2-.2 6.5 0 10 7 10 7s-1.2 2.4-3.5 4.4M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
  star: <path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3Z"/>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  phone: <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></>,
  server: <><rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>,
  shield: <><path d="m12 22 7-4V6l-7-4-7 4v12l7 4Z"/><path d="m9 12 2 2 4-4"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  minus: <path d="M5 12h14"/>,
  arrowRight: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  chevronLeft: <path d="m15 18-6-6 6-6"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  power: <><path d="M12 2v10"/><path d="M6.4 5.7a9 9 0 1 0 11.2 0"/></>,
  rotate: <><path d="M20 11a8 8 0 1 0-1.7 6.7"/><path d="M20 4v7h-7"/></>,
  volume: <><path d="M11 5 6 9H3v6h3l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"/></>,
  volumeOff: <><path d="M11 5 6 9H3v6h3l5 4V5ZM16 9l5 6m0-6-5 6"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></>,
  terminal: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  back: <path d="m15 5-7 7 7 7"/>,
  home: <><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9Z"/><path d="M9 21v-7h6v7"/></>,
  recent: <><rect x="4" y="4" width="16" height="16" rx="3"/><rect x="8" y="8" width="8" height="8" rx="1"/></>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5L4 8m0-5v5h5M4 13a8 8 0 0 0 14 5l2-2m0 5v-5h-5"/></>,
  close: <path d="M5 5 19 19M19 5 5 19"/>,
  check: <path d="m4 12 5 5L20 6"/>,
  alert: <><circle cx="12" cy="12" r="10"/><path d="M12 7v6m0 4h.01"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5m5 5H9"/></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  download: <><path d="M12 3v13m-5-5 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></>,
  slots: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5" strokeDasharray="2.5 2.5"/><path d="M17.5 16.5v2M16.5 17.5h2"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7l0-8Z"/>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  info: <><circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10h.01"/></>,
  wifi: <><path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0m-11 4a5 5 0 0 1 8 0M12 20h.01"/></>,
  wifiOff: <><path d="M2 2 22 22M2 8a15 15 0 0 1 4.3-2.6M9 5.1A15 15 0 0 1 22 8M5 12a10 10 0 0 1 5-2.5m4.8.5a10 10 0 0 1 4.2 2M8 16a5 5 0 0 1 4-1.9M12 20h.01"/></>,
  key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2.5 2.5 1.5 1.5-2.5 2.5-1.5-1.5-3 3"/></>,
  camera: <><path d="M3 7h4l2-3h6l2 3h4v12H3V7Z"/><circle cx="12" cy="13" r="3.5"/></>,
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></>,
  arrowDown: <path d="M12 5v14m-6-6 6 6 6-6"/>,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
};

export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
