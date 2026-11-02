import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { ViewBus } from '../lib/bus';
import type { DataSet } from '../lib/data';
import { clearPersisted, readPersisted, writePersisted } from '../lib/storage';
import { DEFAULT_SETTINGS, TRACK_COLORS, type Field, type Page, type Rule, type Settings, type Timeline } from '../types';

export interface State {
  settings: Settings;
  timelines: Timeline[];
  activeId: string;
  stack: Page[];
  menu: { open: boolean; tab: 'timelines' | 'search' | 'settings'; openRule: string | null };
  search: string;
}
type Action =
  | { t: 'settings'; patch: Partial<Settings> }
  | { t: 'timelines'; list: Timeline[]; activeId?: string }
  | { t: 'active'; id: string }
  | { t: 'menu'; patch: Partial<State['menu']> }
  | { t: 'search'; q: string }
  | { t: 'open'; page: Page }
  | { t: 'replace'; page: Page }
  | { t: 'truncate'; n: number }
  | { t: 'reset'; state: State };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'settings': return { ...s, settings: { ...s.settings, ...a.patch } };
    case 'timelines': return { ...s, timelines: a.list, activeId: a.activeId ?? (a.list.some((t) => t.id === s.activeId) ? s.activeId : a.list[0]?.id ?? '') };
    case 'active': return { ...s, activeId: a.id };
    case 'menu': return { ...s, menu: { ...s.menu, ...a.patch } };
    case 'search': return { ...s, search: a.q };
    case 'open': return { ...s, stack: [...s.stack, a.page] };
    case 'replace': return { ...s, stack: [...s.stack.slice(0, -1), a.page] };
    case 'truncate': return { ...s, stack: s.stack.slice(0, Math.max(0, a.n)) };
    case 'reset': return a.state;
  }
}

let uid = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;
export const newRule = (field: Field = 'character', patch: Partial<Rule> = {}): Rule =>
  ({ id: newId('r'), join: 'and', field, op: 'is', value: '', ...patch });

function defaultTimelines(ds: DataSet): Timeline[] {
  const list: Timeline[] = [{ id: newId('t'), name: 'All events', color: TRACK_COLORS[0], rules: [] }];
  if (ds.entities.has('ashford-academy') && (ds.entityEvents.get('ashford-academy')?.length ?? 0) > 0) {
    list.push({ id: newId('t'), name: 'At Ashford Academy', color: TRACK_COLORS[1], rules: [newRule('location', { value: 'ashford-academy' })] });
  }
  return list;
}

function initialState(ds: DataSet): { state: State; views: ReturnType<typeof readPersisted>['views'] } {
  const p = readPersisted();
  const timelines = p.timelines && p.timelines.length ? p.timelines : defaultTimelines(ds);
  const valid = (pg: Page) =>
    pg && (pg.type === 'event' ? ds.eventById.has(pg.id) : pg.type === 'entity' ? ds.entities.has(pg.id) : ds.episodes.has(pg.id));
  return {
    state: {
      settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
      timelines,
      activeId: p.activeId && timelines.some((t) => t.id === p.activeId) ? p.activeId : timelines[0].id,
      stack: (p.stack ?? []).filter(valid),
      menu: { open: p.menu?.open ?? window.innerWidth >= 900, tab: p.menu?.tab ?? 'timelines', openRule: p.menu?.openRule ?? null },
      search: p.search ?? '',
    },
    views: p.views,
  };
}

export interface Actions {
  setSettings(patch: Partial<Settings>): void;
  addTimeline(opts?: { name?: string; rules?: Rule[] }): string;
  updateTimeline(id: string, patch: Partial<Timeline>): void;
  removeTimeline(id: string): void;
  duplicateTimeline(id: string): void;
  setActive(id: string): void;
  setMenu(patch: Partial<State['menu']>): void;
  setSearch(q: string): void;
  openPage(p: Page): void;
  replaceTop(p: Page): void;
  closeTop(): void;
  closeAll(): void;
  reset(): void;
}
interface Ctx { ds: DataSet; state: State; act: Actions; bus: ViewBus }
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

export function AppProvider({ ds, children }: { ds: DataSet; children: ReactNode }) {
  const init = useRef<ReturnType<typeof initialState> | undefined>(undefined);
  if (!init.current) init.current = initialState(ds);
  const [state, dispatch] = useReducer(reducer, init.current.state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const bus = useMemo(() => {
    const b = new ViewBus(init.current!.views ?? {});
    b.linked = init.current!.state.settings.linkViews && init.current!.state.settings.axis === 'aligned';
    return b;
  }, []);

  useEffect(() => { bus.linked = state.settings.linkViews && state.settings.axis === 'aligned'; }, [bus, state.settings.linkViews, state.settings.axis]);

  // ---- persistence (everything the user can set, plus the pan/zoom of each timeline)
  const persist = useCallback(() => {
    const s = stateRef.current;
    writePersisted({ settings: s.settings, timelines: s.timelines, activeId: s.activeId, views: bus.snapshot(), stack: s.stack, menu: s.menu, search: s.search });
  }, [bus]);
  useEffect(() => { persist(); }, [state, persist]);
  useEffect(() => bus.onSave(persist), [bus, persist]);

  // ---- history: every opened detail page is a history entry, so the browser/phone Back button closes one page
  useEffect(() => {
    const n = stateRef.current.stack.length;
    history.replaceState({ gcw: 0 }, '');
    for (let i = 1; i <= n; i++) history.pushState({ gcw: i }, '');
    const onPop = (e: PopStateEvent) => {
      const d = typeof e.state?.gcw === 'number' ? e.state.gcw : 0;
      dispatch({ t: 'truncate', n: Math.min(d, stateRef.current.stack.length) });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const act = useMemo<Actions>(() => ({
    setSettings: (patch) => dispatch({ t: 'settings', patch }),
    addTimeline: (opts = {}) => {
      const s = stateRef.current;
      const id = newId('t');
      const used = new Set(s.timelines.map((t) => t.color));
      const color = TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[s.timelines.length % TRACK_COLORS.length];
      dispatch({ t: 'timelines', list: [...s.timelines, { id, name: opts.name ?? `Timeline ${s.timelines.length + 1}`, color, rules: opts.rules ?? [] }], activeId: id });
      dispatch({ t: 'menu', patch: { open: true, tab: 'timelines', openRule: id } });
      return id;
    },
    updateTimeline: (id, patch) => dispatch({ t: 'timelines', list: stateRef.current.timelines.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
    removeTimeline: (id) => {
      const s = stateRef.current;
      if (s.timelines.length <= 1) return;
      bus.forget(id);
      dispatch({ t: 'timelines', list: s.timelines.filter((t) => t.id !== id) });
    },
    duplicateTimeline: (id) => {
      const s = stateRef.current;
      const src = s.timelines.find((t) => t.id === id);
      if (!src) return;
      const nid = newId('t');
      dispatch({ t: 'timelines', list: [...s.timelines, { ...src, id: nid, name: src.name + ' copy', rules: src.rules.map((r) => ({ ...r, id: newId('r') })) }], activeId: nid });
    },
    setActive: (id) => dispatch({ t: 'active', id }),
    setMenu: (patch) => dispatch({ t: 'menu', patch }),
    setSearch: (q) => dispatch({ t: 'search', q }),
    openPage: (p) => {
      const top = stateRef.current.stack[stateRef.current.stack.length - 1];
      if (top && top.type === p.type && top.id === p.id) return;
      const n = stateRef.current.stack.length + 1;
      dispatch({ t: 'open', page: p });
      history.pushState({ gcw: n }, '');
    },
    replaceTop: (p) => {
      if (!stateRef.current.stack.length) return;
      dispatch({ t: 'replace', page: p });
      history.replaceState({ gcw: stateRef.current.stack.length }, '');
    },
    closeTop: () => {
      const n = stateRef.current.stack.length;
      if (!n) return;
      if ((history.state?.gcw ?? 0) >= n) history.back();
      else dispatch({ t: 'truncate', n: n - 1 });
    },
    closeAll: () => {
      const n = stateRef.current.stack.length;
      if (!n) return;
      dispatch({ t: 'truncate', n: 0 });
      if ((history.state?.gcw ?? 0) === n) history.go(-n);
    },
    reset: () => {
      clearPersisted();
      bus.stop();
      for (const t of stateRef.current.timelines) bus.forget(t.id);
      const fresh = initialState(ds).state;
      dispatch({ t: 'reset', state: { ...fresh, menu: { ...fresh.menu, open: window.innerWidth >= 900 } } });
      history.replaceState({ gcw: 0 }, '');
    },
  }), [bus, ds]);

  const value = useMemo(() => ({ ds, state, act, bus }), [ds, state, act, bus]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
