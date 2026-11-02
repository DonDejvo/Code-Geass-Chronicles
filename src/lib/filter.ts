import type { DataSet } from './data';
import { fold } from './fold';
import type { Ev, Kind, Rule } from '../types';
import { FIELD_LABEL } from '../types';

const ENTITY_FIELDS = new Set(['character', 'faction', 'location', 'equipment', 'concept', 'event']);

export const isActive = (r: Rule) => r.value.trim() !== '';

/** Does the event satisfy "field IS value" (before the NOT is applied)? */
export function matchRule(ev: Ev, r: Rule, ds: DataSet): boolean {
  if (ENTITY_FIELDS.has(r.field)) return (ev.links[r.field as Kind] ?? []).includes(r.value);
  if (r.field === 'episode') return ev.ep === r.value;
  if (r.field === 'series') return ds.episodes.get(ev.ep)?.series === r.value;
  return (ev.hay ?? '').includes(fold(r.value));
}

export const ruleTruth = (ev: Ev, r: Rule, ds: DataSet) => (r.op === 'is') === matchRule(ev, r, ds);

/**
 * Rules are read top to bottom; AND binds tighter than OR:
 *   A AND B OR C AND D  =  (A AND B) OR (C AND D)
 * `isnot` negates a single rule (NOT EQUAL). The first rule's join is ignored.
 */
export function evalRules(ev: Ev, rules: Rule[], ds: DataSet): boolean {
  const active = rules.filter(isActive);
  if (!active.length) return true;
  let group = true;
  for (let i = 0; i < active.length; i++) {
    const r = active[i];
    if (i > 0 && r.join === 'or') {
      if (group) return true;
      group = true;
    }
    group = group && ruleTruth(ev, r, ds);
  }
  return group;
}

export function filterEvents(events: Ev[], rules: Rule[], ds: DataSet): Ev[] {
  if (!rules.some(isActive)) return events;
  return events.filter((e) => evalRules(e, rules, ds));
}

export function valueLabel(r: Rule, ds: DataSet): string {
  if (r.field === 'text') return `“${r.value}”`;
  if (r.field === 'episode') {
    const ep = ds.episodes.get(r.value);
    return ep ? `${ep.series} E${String(ep.number ?? 0).padStart(2, '0')} ${ep.title}` : r.value;
  }
  if (r.field === 'series') return ds.series.get(r.value)?.label ?? r.value;
  return ds.entities.get(r.value)?.title ?? r.value;
}

/** e.g. "(Character is Lelouch AND Location is Ashford Academy) OR Faction is not Britannia" */
export function describeRules(rules: Rule[], ds: DataSet): string {
  const active = rules.filter(isActive);
  if (!active.length) return 'All events';
  const groups: string[][] = [[]];
  active.forEach((r, i) => {
    if (i > 0 && r.join === 'or') groups.push([]);
    const verb = r.field === 'text' ? (r.op === 'is' ? 'contains' : 'does not contain') : r.op === 'is' ? 'is' : 'is not';
    groups[groups.length - 1].push(`${FIELD_LABEL[r.field]} ${verb} ${valueLabel(r, ds)}`);
  });
  return groups.map((g) => (groups.length > 1 && g.length > 1 ? `(${g.join(' AND ')})` : g.join(' AND '))).join(' OR ');
}
