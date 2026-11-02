import { useMemo, useState } from 'react';
import type { DataSet } from '../lib/data';
import { describeRules } from '../lib/filter';
import { FIELDS, FIELD_LABEL, KINDS, type Field, type Kind, type Rule, type Timeline } from '../types';
import { newRule, useApp } from '../state/store';
import { Combobox, type Opt } from './Combobox';

const cache = new WeakMap<DataSet, Map<Field, Opt[]>>();
export function optionsFor(ds: DataSet, field: Field): Opt[] {
  let m = cache.get(ds);
  if (!m) cache.set(ds, (m = new Map()));
  const hit = m.get(field);
  if (hit) return hit;
  let out: Opt[] = [];
  if ((KINDS as string[]).includes(field)) {
    for (const e of ds.raw.entities) {
      if (!e.kinds.includes(field as Kind)) continue;
      const n = ds.events.filter((ev) => ev.links[field as Kind].includes(e.id)).length;
      if (n) out.push({ id: e.id, label: e.title, sub: `${n} event${n > 1 ? 's' : ''}`, weight: n, alt: e.aliases.join(' ') });
    }
  } else if (field === 'episode') {
    for (const ep of ds.episodeList) {
      const n = ds.epEvents.get(ep.id)?.length ?? 0;
      if (n) out.push({ id: ep.id, label: `${ep.series} E${String(ep.number ?? 0).padStart(2, '0')} · ${ep.title}`, sub: `${n} events`, weight: 0 });
    }
    out = out.map((o, i) => ({ ...o, weight: out.length - i }));
  } else if (field === 'series') {
    for (const s of ds.raw.series) {
      const n = ds.events.filter((ev) => ds.episodes.get(ev.ep)?.series === s.id).length;
      if (n) out.push({ id: s.id, label: s.label, sub: `${n} events`, weight: 100 - s.slot });
    }
  }
  m.set(field, out);
  return out;
}

export function RuleEditor({ timeline }: { timeline: Timeline }) {
  const { ds, act } = useApp();
  const [fresh, setFresh] = useState<string | null>(null);
  const setRules = (rules: Rule[]) => act.updateTimeline(timeline.id, { rules });
  const patch = (id: string, p: Partial<Rule>) => setRules(timeline.rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const text = useMemo(() => describeRules(timeline.rules, ds), [timeline.rules, ds]);
  return (
    <div className="rules">
      {timeline.rules.map((r, i) => (
        <div className="rule" key={r.id}>
          {i === 0 ? <span className="join first">WHERE</span> : (
            <button className={`join ${r.join}`} title="Toggle AND / OR" onClick={() => patch(r.id, { join: r.join === 'and' ? 'or' : 'and' })}>
              {r.join.toUpperCase()}
            </button>
          )}
          <select aria-label="Filter by" value={r.field} onChange={(e) => patch(r.id, { field: e.target.value as Field, value: '' })}>
            {FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
          </select>
          <select aria-label="Operator" className={r.op === 'isnot' ? 'not' : ''} value={r.op} onChange={(e) => patch(r.id, { op: e.target.value as Rule['op'] })}>
            <option value="is">{r.field === 'text' ? 'contains' : 'is'}</option>
            <option value="isnot">{r.field === 'text' ? 'does not contain' : 'is not'}</option>
          </select>
          <div className="rule-value">
            {r.field === 'text'
              ? <input type="text" value={r.value} placeholder="word or phrase" aria-label="Text" onChange={(e) => patch(r.id, { value: e.target.value })} />
              : <Combobox options={optionsFor(ds, r.field)} value={r.value} onChange={(v) => patch(r.id, { value: v })} ariaLabel={FIELD_LABEL[r.field]}
                  placeholder={`Search ${FIELD_LABEL[r.field].toLowerCase()}…`} autoFocus={fresh === r.id} />}
          </div>
          <button className="icon-btn danger" aria-label="Remove rule" onClick={() => setRules(timeline.rules.filter((x) => x.id !== r.id))}>×</button>
        </div>
      ))}
      <div className="rule-actions">
        <button className="btn small" onClick={() => { const nr = newRule('character'); setFresh(nr.id); setRules([...timeline.rules, nr]); }}>+ Add rule</button>
        {timeline.rules.length > 0 && <button className="btn small ghost" onClick={() => setRules([])}>Clear</button>}
      </div>
      <p className="expr" aria-live="polite">{text}</p>
      <p className="hint">AND binds tighter than OR. Tap AND/OR to switch. “is not” excludes events.</p>
    </div>
  );
}
