import type { ReactNode } from 'react';

const paths = {
  library: <><path d="M4 4h6v16H4zM14 4h6v16h-6zM4 8h6M14 8h6" /></>,
  shelves: <><path d="M3 5h18v15H3zM3 12h18M8 5v7M16 12v8" /></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></>,
  graph: <><path d="m6 6 12 2-6 10L6 6Z" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="8" r="3" /><circle cx="12" cy="18" r="3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>,
  settings: <><path d="m9 3-.6 2.3-2 .9-2.1-.6-2 3.5 1.6 1.7v2.4l-1.6 1.7 2 3.5 2.1-.6 2 .9L9 21h6l.6-2.3 2-.9 2.1.6 2-3.5-1.6-1.7v-2.4l1.6-1.7-2-3.5-2.1.6-2-.9L15 3H9Z" /><circle cx="12" cy="12" r="3" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  list: <><path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M10 4v16" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  reset: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></>,
  lightning: <path d="m13 2-9 12h7l-1 8L21 9h-8l1-7Z" />,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" /></>,
  waveform: <path d="M5 10v4M9 6v12M13 3v18M17 7v10M21 10v4" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="M12 8v5M12 16h.01" /></>,
  hand: <><path d="M8 13V5a2 2 0 0 1 4 0v7M12 6a2 2 0 0 1 4 0v6M16 8a2 2 0 0 1 4 0v7a7 7 0 0 1-12 5l-5-6a2 2 0 0 1 3-3l2 2Z" /><path d="M8 8V7a2 2 0 0 0-4 0v5" /></>,
  send: <path d="M12 20V4m-6 6 6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 17v4h14v-4" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  file: <><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  sparkles: <><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z" /></>,
  code: <><path d="M9 7 4 12l5 5M15 7l5 5-5 5" /></>,
  filePlus: <><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5" /><path d="M12 12v6M9 15h6" /></>,
  folderPlus: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v11H3V6Z" /><path d="M12 10v6M9 13h6" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M4 15v5h16v-5" /></>,
  archive: <><path d="M3 5h18v4H3zM5 9v11h14V9" /><path d="M9 13h6m-3-3v7m-3-3 3 3 3-3" /></>,
} satisfies Record<string, ReactNode>;

export type WorkspaceIconName = keyof typeof paths;

export function WorkspaceIcon({ name, size = 18 }: { name: WorkspaceIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
