import { useMemo, useState } from 'react';
import { entityStats, epCode, primaryKind, whenLabel } from '../lib/data';
import { KINDS, KIND_LABEL, KIND_PLURAL, type Ev, type Kind } from '../types';
import { newRule, useApp } from '../state/store';
import { useLocate } from '../state/locate';
import { EntityLink, Rich } from './EntityLink';

function EventLink({ ev }: { ev: Ev }) {
  const { ds, act } = useApp();
  const w = whenLabel(ds, ev);
  return (
    <a className="evlink" href={`#/event/${ev.id}`} onClick={(e) => { e.preventDefault(); act.openPage({ type: 'event', id: ev.id }); }}>
      <span className="evlink-t">{ev.title}</span><small>{w.text}</small>
    </a>
  );
}
function EpisodeLink({ id, children }: { id: string; children?: React.ReactNode }) {
  const { ds, act } = useApp();
  const ep = ds.episodes.get(id);
  if (!ep) return <>{children}</>;
  return <a className="elink k-ep" href={`#/episode/${id}`} onClick={(e) => { e.preventDefault(); act.openPage({ type: 'episode', id }); }}>{children ?? ep.title}</a>;
}

export function titleOf(ds: ReturnType<typeof useApp>['ds'], p: { type: string; id: string }): string {
  return p.type === 'event' ? ds.eventById.get(p.id)?.title ?? '' : p.type === 'entity' ? ds.entities.get(p.id)?.title ?? '' : ds.episodes.get(p.id)?.title ?? '';
}

export function EventPage({ id }: { id: string }) {
  const { ds, act } = useApp();
  const locate = useLocate();
  const ev = ds.eventById.get(id);
  if (!ev) return <p>Event not found.</p>;
  const w = whenLabel(ds, ev);
  const i = ds.events.indexOf(ev);
  const prev = ds.events[i - 1], next = ds.events[i + 1];
  return (
    <article className="page">
      <p className="eyebrow">Event · <EpisodeLink id={ev.ep}>{epCode(ds, ev.ep)} {ds.episodes.get(ev.ep)?.title}</EpisodeLink></p>
      <h2>{ev.title}</h2>
      <div className="badges">
        <span className="badge">{w.date ?? 'Date not stated'}</span>
        {ev.flashback && <span className="badge violet">Flashback</span>}
        {ev.review && <span className="badge crimson" title="Extraction confidence is low">Needs review</span>}
      </div>
      <p className="lead">{ev.summary}</p>
      {ev.source && <blockquote><Rich text={ev.source} /><cite>Source text · {epCode(ds, ev.ep)}</cite></blockquote>}
      <div className="actions">
        <button className="btn" onClick={() => locate(ev.id)}>◎ Locate on timeline</button>
      </div>
      {KINDS.map((k) => {
        const ids = (ev.links[k] ?? []).filter((x) => ds.entities.has(x));
        if (!ids.length) return null;
        return (
          <section key={k}>
            <h3>{KIND_PLURAL[k]}</h3>
            <ul className="chips">{ids.map((x) => <li key={x}><EntityLink id={x} /></li>)}</ul>
          </section>
        );
      })}
      <nav className="prevnext" aria-label="Neighbouring events">
        <button className="btn ghost" disabled={!prev} onClick={() => prev && act.replaceTop({ type: 'event', id: prev.id })}>← {prev ? prev.title : 'Start'}</button>
        <button className="btn ghost" disabled={!next} onClick={() => next && act.replaceTop({ type: 'event', id: next.id })}>{next ? next.title : 'End'} →</button>
      </nav>
    </article>
  );
}

export function EntityPage({ id }: { id: string }) {
  const { ds, state, act } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const e = ds.entities.get(id);
  const st = useMemo(() => entityStats(ds, id), [ds, id]);
  const together = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of st.list) for (const k of KINDS) for (const x of ev.links[k] ?? []) if (x !== id) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].filter(([x]) => ds.entities.has(x)).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [ds, id, st.list]);
  if (!e) return <p>Entity not found.</p>;
  const field = primaryKind(e);
  const facts = Object.entries(e.infobox).filter(([, v]) => v && v.trim());
  const groupsByKind = new Map<string, Ev[]>();
  for (const ev of st.list) { const key = ev.ep; (groupsByKind.get(key) ?? groupsByKind.set(key, []).get(key)!).push(ev); }
  const active = state.timelines.find((t) => t.id === state.activeId);
  const filterField = field === 'concept' ? 'concept' : field;
  const addToActive = () => {
    if (!active) return;
    act.updateTimeline(active.id, { rules: [...active.rules, newRule(filterField as Kind, { value: id })] });
    act.closeAll(); act.setMenu({ open: true, tab: 'timelines', openRule: active.id });
  };
  const newTl = () => {
    act.addTimeline({ name: e.title, rules: [newRule(filterField as Kind, { value: id })] });
    act.closeAll();
  };
  return (
    <article className="page">
      <p className="eyebrow">{e.kinds.map((k) => KIND_LABEL[k]).join(' · ')}</p>
      <h2>{e.title}</h2>
      {e.aliases.length > 0 && <p className="aka">Also: {e.aliases.slice(0, 6).join(', ')}</p>}
      <div className="stats">
        <div><b>{st.list.length}</b><small>events</small></div>
        <div><b>{st.first ? epCode(ds, st.first.ep) : '—'}</b><small>first seen</small></div>
        <div><b>{st.last ? epCode(ds, st.last.ep) : '—'}</b><small>last seen</small></div>
      </div>
      {(st.first || st.last) && (
        <p className="firstlast">
          {st.first && <>First: <EventLink ev={st.first} /></>}
          {st.last && st.last !== st.first && <>Last: <EventLink ev={st.last} /></>}
        </p>
      )}
      {e.summary && <p className="lead"><Rich text={e.summary} /></p>}
      <div className="actions">
        <button className="btn" onClick={addToActive} disabled={!active}>+ Filter “{active?.name ?? '…'}”</button>
        <button className="btn ghost" onClick={newTl}>New timeline</button>
        {e.wiki && <a className="btn ghost" href={e.wiki} target="_blank" rel="noreferrer noopener">Fandom wiki ↗</a>}
      </div>
      {facts.length > 0 && (
        <section><h3>Details</h3>
          <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd><Rich text={v} /></dd></div>)}</dl>
        </section>
      )}
      <section>
        <h3>Appears in {st.list.length} event{st.list.length === 1 ? '' : 's'}</h3>
        {st.list.length === 0 && <p className="hint">No events recorded yet.</p>}
        {[...groupsByKind.entries()].map(([ep, evs]) => {
          const isOpen = open[ep] ?? groupsByKind.size <= 6;
          return (
            <div key={ep} className="group">
              <button className="group-h" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [ep]: !isOpen })}>
                <span>{epCode(ds, ep)} · {ds.episodes.get(ep)?.title}</span><small>{evs.length}</small>
              </button>
              {isOpen && <ul className="evlist">{evs.map((ev) => <li key={ev.id}><EventLink ev={ev} /></li>)}</ul>}
            </div>
          );
        })}
      </section>
      {together.length > 0 && (
        <section><h3>Appears with</h3>
          <ul className="chips">{together.map(([x, n]) => <li key={x}><EntityLink id={x} /><small>{n}</small></li>)}</ul>
        </section>
      )}
    </article>
  );
}

export function EpisodePage({ id }: { id: string }) {
  const { ds, act } = useApp();
  const ep = ds.episodes.get(id);
  if (!ep) return <p>Episode not found.</p>;
  const i = ds.episodeList.indexOf(ep);
  const prev = ds.episodeList[i - 1], next = ds.episodeList[i + 1];
  const evs = ds.epEvents.get(id) ?? [];
  return (
    <article className="page">
      <p className="eyebrow">{ds.series.get(ep.series)?.label ?? ep.series} · {epCode(ds, id)}</p>
      <h2>{ep.title}</h2>
      {ep.air && <div className="badges"><span className="badge">Aired {ep.air}</span></div>}
      {ep.synopsis.length ? ep.synopsis.map((p, j) => <p key={j}><Rich text={p} /></p>) : <p className="hint">No synopsis available.</p>}
      {ep.source && <p className="hint">{ep.source.note} {ep.source.url && <a href={ep.source.url} target="_blank" rel="noreferrer noopener">{ep.source.source}</a>}</p>}
      <section>
        <h3>{evs.length} event{evs.length === 1 ? '' : 's'}</h3>
        {evs.length === 0 && <p className="hint">Events for this episode have not been extracted yet.</p>}
        <ul className="evlist">{evs.map((ev) => <li key={ev.id}><EventLink ev={ev} /></li>)}</ul>
      </section>
      <nav className="prevnext">
        <button className="btn ghost" disabled={!prev} onClick={() => prev && act.replaceTop({ type: 'episode', id: prev.id })}>← {prev ? prev.title : 'Start'}</button>
        <button className="btn ghost" disabled={!next} onClick={() => next && act.replaceTop({ type: 'episode', id: next.id })}>{next ? next.title : 'End'} →</button>
      </nav>
    </article>
  );
}
