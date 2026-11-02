import type { Page, Settings, Timeline } from '../types';
import type { View } from './bus';

export const STORAGE_KEY = 'gcw:v1';
export interface Persisted {
  settings: Settings;
  timelines: Timeline[] | null;
  activeId: string | null;
  views: Record<string, View>;
  stack: Page[];
  menu: { open: boolean | null; tab: 'timelines' | 'search' | 'settings'; openRule: string | null };
  search: string;
}

export function readPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch { return {}; }
}
let timer = 0;
let pending: Persisted | null = null;
function flush() {
  window.clearTimeout(timer);
  if (!pending) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pending)); } catch { /* private mode / quota: the app still works */ }
  pending = null;
}
// A debounced write must not be lost when the tab is closed or backgrounded mid-drag.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
export function writePersisted(p: Persisted) {
  pending = p;
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 200);
}
export function clearPersisted() {
  pending = null; window.clearTimeout(timer);
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
