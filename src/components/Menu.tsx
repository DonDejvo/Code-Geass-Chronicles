import { useMemo } from 'react';
import { fold } from '../lib/fold';
import { epCode, primaryKind, whenLabel } from '../lib/data';
import { KIND_LABEL, TRACK_COLORS, type Settings } from '../types';
import { useApp } from '../state/store';
import { RuleEditor } from './RuleEditor';

const isSmall = () => window.innerWidth < 900;

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}
function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}

function TimelinesTab({ counts }: { counts: Record<string, number> }) {
  const { state, act, ds } = useApp();
  return (
    <div className="tab-body">
      {state.timelines.map((t) => {
        const open = state.menu.openRule === t.id;
        return (
          <section key={t.id} className={`tl-card${state.activeId === t.id ? ' active' : ''}`} style={{ ['--tc' as string]: t.color }}>
            <header>
              <span className="swatch" aria-hidden />
              <input className="name" value={t.name} aria-label="Timeline name" onFocus={() => act.setActive(t.id)}
                onChange={(e) => act.updateTimeline(t.id, { name: e.target.value })} />
              <span className="count" title="events shown">{counts[t.id] ?? 0}/{ds.events.length}</span>
              <button className="icon-btn" aria-expanded={open} aria-label={open ? 'Collapse' : 'Edit filters'}
                onClick={() => { act.setActive(t.id); act.setMenu({ openRule: open ? null : t.id }); }}>{open ? '▴' : '▾'}</button>
            </header>
            {open && (
              <div className="tl-body">
                <div className="colors" role="radiogroup" aria-label="Colour">
                  {TRACK_COLORS.map((c) => (
                    <button key={c} role="radio" aria-checked={t.color === c} className={t.color === c ? 'on' : ''} style={{ background: c }}
                      aria-label={c} onClick={() => act.updateTimeline(t.id, { color: c })} />
                  ))}
                  <span className="grow" />
                  <button className="btn small ghost" onClick={() => act.duplicateTimeline(t.id)}>Duplicate</button>
                  <button className="btn small ghost danger" disabled={state.timelines.length <= 1} onClick={() => act.removeTimeline(t.id)}>Delete</button>
                </div>
                <RuleEditor timeline={t} />
              </div>
            )}
          </section>
        );
      })}
      <button className="btn wide" onClick={() => act.addTimeline()} disabled={state.timelines.length >= 6}>+ Add timeline</button>
      {state.timelines.length >= 6 && <p className="hint">Maximum of 6 timelines.</p>}
    </div>
  );
}

function SearchTab() {
  const { ds, state, act } = useApp();
  const q = state.search;
  const f = fold(q);
  const res = useMemo(() => {
    if (f.length < 2) return null;
    const events = ds.events.filter((e) => e.hay!.includes(f));
    const ents = ds.raw.entities.filter((e) => fold(e.title).includes(f) || e.aliases.some((a) => fold(a).includes(f)));
    ents.sort((a, b) => Number(fold(b.title).startsWith(f)) - Number(fold(a.title).startsWith(f)) || (ds.entityEvents.get(b.id)?.length ?? 0) - (ds.entityEvents.get(a.id)?.length ?? 0));
    const eps = ds.episodeList.filter((e) => fold(e.title).includes(f));
    return { events, ents, eps };
  }, [f, ds]);
  const go = (type: 'event' | 'entity' | 'episode', id: string) => { act.openPage({ type, id }); if (isSmall()) act.setMenu({ open: false }); };
  return (
    <div className="tab-body">
      <input className="search" type="search" placeholder="Search events, characters, places, equipment…" value={q}
        onChange={(e) => act.setSearch(e.target.value)} aria-label="Search" />
      {!res && <p className="hint">Type at least 2 letters. Matching events are ringed on every timeline.</p>}
      {res && (
        <>
          <p className="hint">{res.events.length} events · {res.ents.length} entities · {res.eps.length} episodes
            {' '}<button className="linklike" onClick={() => { act.setActive(state.activeId); const t = state.timelines.find((x) => x.id === state.activeId); if (t) act.updateTimeline(t.id, { rules: [...t.rules, { id: `r${Date.now().toString(36)}`, join: 'and', field: 'text', op: 'is', value: q }] }); act.setMenu({ tab: 'timelines', openRule: state.activeId }); }}>Use as filter</button></p>
          {res.ents.length > 0 && <h4>Entities</h4>}
          <ul className="results">
            {res.ents.slice(0, 20).map((e) => (
              <li key={e.id}><button onClick={() => go('entity', e.id)}><span className={`dot k-${primaryKind(e)}`} /> {e.title}<small>{KIND_LABEL[primaryKind(e)]} · {ds.entityEvents.get(e.id)?.length ?? 0} events</small></button></li>
            ))}
          </ul>
          {res.events.length > 0 && <h4>Events</h4>}
          <ul className="results">
            {res.events.slice(0, 40).map((e) => (
              <li key={e.id}><button onClick={() => go('event', e.id)}>{e.title}<small>{whenLabel(ds, e).text}</small></button></li>
            ))}
          </ul>
          {res.eps.length > 0 && <h4>Episodes</h4>}
          <ul className="results">
            {res.eps.slice(0, 20).map((e) => (
              <li key={e.id}><button onClick={() => go('episode', e.id)}>{e.title}<small>{epCode(ds, e.id)}</small></button></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SettingsTab() {
  const { state, act, ds } = useApp();
  const s = state.settings;
  const set = (p: Partial<Settings>) => act.setSettings(p);
  return (
    <div className="tab-body">
      <h4>Layout</h4>
      <Segmented label="Axis" value={s.axis} onChange={(v) => set({ axis: v })} options={[{ v: 'aligned', l: 'Aligned' }, { v: 'packed', l: 'Packed' }]} />
      <p className="hint">Aligned: every timeline shares one time axis, so you can compare them. Packed: each timeline closes the gaps left by filtered-out events.</p>
      <Toggle label="Link pan & zoom" hint={s.axis === 'packed' ? 'Only in aligned mode' : 'Dragging one timeline moves all'} checked={s.linkViews && s.axis === 'aligned'} onChange={(v) => set({ linkViews: v })} />
      <h4>Labels</h4>
      <label className="range"><span>Label size <b>{Math.round(s.labelScale * 100)}%</b></span>
        <input type="range" min={0.8} max={1.5} step={0.05} value={s.labelScale} onChange={(e) => set({ labelScale: Number(e.target.value) })} /></label>
      <label className="range"><span>Max label rows <b>{s.maxLanes}</b></span>
        <input type="range" min={1} max={10} step={1} value={s.maxLanes} onChange={(e) => set({ maxLanes: Number(e.target.value) })} /></label>
      <Toggle label="Show dates under points" hint="Only events that state a date have one" checked={s.showDates} onChange={(v) => set({ showDates: v })} />
      <Toggle label="Show episode markers" checked={s.showEpisodes} onChange={(v) => set({ showEpisodes: v })} />
      <h4>Behaviour</h4>
      <Toggle label="Momentum when dragging" checked={s.inertia} onChange={(v) => set({ inertia: v })} />
      <Toggle label="Ring search matches" checked={s.highlightSearch} onChange={(v) => set({ highlightSearch: v })} />
      <h4>Look</h4>
      <Segmented label="Accent" value={s.accent} onChange={(v) => set({ accent: v })} options={[{ v: 'gold', l: 'Gold' }, { v: 'violet', l: 'Violet' }, { v: 'crimson', l: 'Crimson' }]} />
      <h4>Data</h4>
      <p className="hint">{ds.events.length} events · {ds.raw.entities.length} entities · {ds.episodeList.length} episodes.<br />Settings, timelines, filters, search and the open pages are saved in this browser.</p>
      <button className="btn wide danger" onClick={() => { if (window.confirm('Reset all timelines, filters and settings?')) act.reset(); }}>Reset everything</button>
      <p className="credit">{ds.raw.meta.credit}</p>
    </div>
  );
}

export function Menu({ counts }: { counts: Record<string, number> }) {
  const { state, act } = useApp();
  const tab = state.menu.tab;
  const tabs: { id: typeof tab; l: string }[] = [{ id: 'timelines', l: 'Timelines' }, { id: 'search', l: 'Search' }, { id: 'settings', l: 'Settings' }];
  return (
    <>
      <div className={`scrim${state.menu.open ? ' on' : ''}`} onClick={() => act.setMenu({ open: false })} />
      <aside className={`menu${state.menu.open ? ' open' : ''}`} aria-label="Filters, search and settings" aria-hidden={!state.menu.open}>
        <div className="menu-head">
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => act.setMenu({ tab: t.id })}>{t.l}</button>
            ))}
          </div>
          <button className="icon-btn" aria-label="Close menu" onClick={() => act.setMenu({ open: false })}>×</button>
        </div>
        <div className="menu-scroll">
          {tab === 'timelines' && <TimelinesTab counts={counts} />}
          {tab === 'search' && <SearchTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </aside>
    </>
  );
}
