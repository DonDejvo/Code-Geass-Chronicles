import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadDataSet, type DataSet } from './lib/data';
import { filterEvents } from './lib/filter';
import { computeWorld, type World } from './lib/layout';
import { fold } from './lib/fold';
import type { View } from './lib/bus';
import { AppProvider, useApp } from './state/store';
import { LocateCtx } from './state/locate';
import { Menu } from './components/Menu';
import { TrackCard } from './components/TrackCard';
import { DetailStack } from './components/DetailStack';

function Shell() {
  const { ds, state, act, bus } = useApp();
  const { timelines, settings } = state;
  const [fontTick, setFontTick] = useState(0);

  useEffect(() => { document.documentElement.dataset.accent = settings.accent; }, [settings.accent]);
  useEffect(() => {
    const f = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!f) return;
    const bump = () => setFontTick((n) => n + 1);
    f.load('600 14px "Chakra Petch"').then(bump, bump);
    f.ready.then(bump, bump);
  }, []);

  const globalWorld = useMemo(() => computeWorld(ds.events), [ds]);
  const models = useMemo(() => timelines.map((t) => {
    const events = filterEvents(ds.events, t.rules, ds);
    const world: World = settings.axis === 'aligned' ? globalWorld : computeWorld(events);
    return { t, events, world };
  }), [timelines, ds, settings.axis, globalWorld]);
  const counts = useMemo(() => Object.fromEntries(models.map((m) => [m.t.id, m.events.length])), [models]);

  const highlight = useMemo(() => {
    const f = fold(state.search);
    if (!settings.highlightSearch || f.length < 2) return new Set<string>();
    return new Set(ds.events.filter((e) => e.hay!.includes(f)).map((e) => e.id));
  }, [state.search, settings.highlightSearch, ds]);

  const open = useCallback((id: string) => act.openPage({ type: 'event', id }), [act]);

  const locate = useCallback((eventId: string) => {
    act.closeAll();
    if (window.innerWidth < 900) act.setMenu({ open: false });
    const targets: Record<string, View> = {};
    for (const m of models) {
      const x = m.world.x.get(eventId) ?? (bus.linked ? globalWorld.x.get(eventId) : undefined);
      if (x === undefined) continue;
      const cur = bus.get(m.t.id);
      targets[m.t.id] = { cx: x, k: Math.max(cur?.k ?? 0.8, 0.8) };
    }
    setTimeout(() => bus.flyTo(targets), 60);
  }, [act, bus, models, globalWorld]);

  return (
    <LocateCtx.Provider value={locate}>
      <div className={`app${state.menu.open ? ' menu-open' : ''}`}>
        <header className="topbar">
          <button className="icon-btn burger" aria-label="Toggle menu" aria-expanded={state.menu.open} onClick={() => act.setMenu({ open: !state.menu.open })}>☰</button>
          <div className="brand"><i aria-hidden /><b>Code Geass Chronicles</b></div>
          <span className="grow" />
          <button className="btn small" onClick={() => act.addTimeline()} disabled={timelines.length >= 6}>+ <span className="hide-s">Timeline</span></button>
          <button className="btn small ghost" onClick={() => act.setMenu({ open: true, tab: 'search' })} aria-label="Search">⌕ <span className="hide-s">Search</span></button>
        </header>
        <div className="body">
          <Menu counts={counts} />
          <main className="tracks">
            {models.map((m) => (
              <TrackCard key={m.t.id} timeline={m.t} events={m.events} world={m.world} ds={ds} settings={settings} bus={bus}
                highlight={highlight} fontTick={fontTick} active={state.activeId === m.t.id} canRemove={timelines.length > 1}
                onOpen={open} onActivate={() => state.activeId !== m.t.id && act.setActive(m.t.id)}
                onEdit={() => { act.setActive(m.t.id); act.setMenu({ open: true, tab: 'timelines', openRule: m.t.id }); }}
                onRemove={() => act.removeTimeline(m.t.id)} />
            ))}
            <footer className="foot">Drag to pan · scroll or pinch to zoom · tap a title for details</footer>
          </main>
        </div>
        <DetailStack />
      </div>
    </LocateCtx.Provider>
  );
}

export default function App() {
  const [ds, setDs] = useState<DataSet | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { loadDataSet(`${import.meta.env.BASE_URL}data/timeline.json`).then(setDs, (e) => setErr(String(e.message ?? e))); }, []);
  if (err) return <div className="splash"><p>Could not load the timeline data.</p><small>{err}</small><button className="btn" onClick={() => location.reload()}>Retry</button></div>;
  if (!ds) return <div className="splash"><i className="spin" aria-hidden /><p>Loading events…</p></div>;
  return <AppProvider ds={ds}><Shell /></AppProvider>;
}
