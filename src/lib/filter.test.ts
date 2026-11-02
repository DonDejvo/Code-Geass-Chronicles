import { describe, expect, it } from 'vitest';
import { buildDataSet } from './data';
import { evalRules, filterEvents, describeRules } from './filter';
import type { Ev, Kind, Raw, Rule } from '../types';

const links = (o: Partial<Record<Kind, string[]>>): Record<Kind, string[]> =>
  ({ character: [], faction: [], location: [], equipment: [], concept: [], event: [], ...o });
const mk = (id: string, order: number, l: Partial<Record<Kind, string[]>>, title = id): Ev => ({
  id, ep: 'R1-01', order, idx: order, title, summary: '', source: '', links: links(l), flashback: false,
  date: { kind: 'unknown', abs: null, rel: null, anchor: null }, conf: 1, review: false, flags: [],
});
const raw: Raw = {
  meta: { generated: '', credit: '' },
  series: [{ id: 'R1', slot: 1, label: 'R1', note: '' }],
  episodes: [{ id: 'R1-01', series: 'R1', number: 1, title: 'Pilot', wiki: '', air: null, synopsis: [], order: 1001 }],
  entities: [
    { id: 'lelouch', title: 'Lelouch', kinds: ['character'], wiki: '', summary: '', infobox: {}, aliases: [] },
    { id: 'suzaku', title: 'Suzaku', kinds: ['character'], wiki: '', summary: '', infobox: {}, aliases: [] },
    { id: 'ashford', title: 'Ashford Academy', kinds: ['location'], wiki: '', summary: '', infobox: {}, aliases: [] },
  ],
  events: [
    mk('e1', 0, { character: ['lelouch'], location: ['ashford'] }, 'Lelouch at school'),
    mk('e2', 1, { character: ['lelouch', 'suzaku'] }, 'Both fight'),
    mk('e3', 2, { character: ['suzaku'], location: ['ashford'] }, 'Suzaku at school'),
    mk('e4', 3, {}, 'Nothing'),
  ],
};
const ds = buildDataSet(raw);
let n = 0;
const r = (field: Rule['field'], value: string, op: Rule['op'] = 'is', join: Rule['join'] = 'and'): Rule =>
  ({ id: String(n++), field, value, op, join });
const ids = (rules: Rule[]) => filterEvents(ds.events, rules, ds).map((e) => e.id).join(',');

describe('filters', () => {
  it('no rules and empty-value rules keep everything', () => {
    expect(ids([])).toBe('e1,e2,e3,e4');
    expect(ids([r('character', '')])).toBe('e1,e2,e3,e4');
  });
  it('single rule', () => expect(ids([r('character', 'lelouch')])).toBe('e1,e2'));
  it('AND', () => expect(ids([r('character', 'lelouch'), r('location', 'ashford')])).toBe('e1'));
  it('OR', () => expect(ids([r('character', 'lelouch'), r('location', 'ashford', 'is', 'or')])).toBe('e1,e2,e3'));
  it('NOT EQUAL', () => expect(ids([r('character', 'lelouch', 'isnot')])).toBe('e3,e4'));
  it('AND with NOT: Suzaku but not at Ashford', () =>
    expect(ids([r('character', 'suzaku'), r('location', 'ashford', 'isnot')])).toBe('e2'));
  it('AND binds tighter than OR', () => {
    // lelouch AND suzaku  OR  location ashford  => e2 or (e1,e3)
    expect(ids([r('character', 'lelouch'), r('character', 'suzaku'), r('location', 'ashford', 'is', 'or')])).toBe('e1,e2,e3');
    // location ashford OR lelouch AND suzaku  => same set, order of rules does not matter for this pair
    expect(ids([r('location', 'ashford'), r('character', 'lelouch', 'is', 'or'), r('character', 'suzaku')])).toBe('e1,e2,e3');
    // lelouch OR suzaku AND ashford => e1,e2 (lelouch) + e3 (suzaku&ashford)
    expect(ids([r('character', 'lelouch'), r('character', 'suzaku', 'is', 'or'), r('location', 'ashford')])).toBe('e1,e2,e3');
    // suzaku OR lelouch AND ashford => e2,e3 + e1
    expect(ids([r('character', 'suzaku'), r('character', 'lelouch', 'is', 'or'), r('location', 'ashford')])).toBe('e1,e2,e3');
  });
  it('text rule searches title/summary/linked names', () => {
    expect(ids([r('text', 'school')])).toBe('e1,e3');
    expect(ids([r('text', 'ashford')])).toBe('e1,e3'); // via linked entity title
    expect(ids([r('text', 'school', 'isnot')])).toBe('e2,e4');
  });
  it('series / episode', () => {
    expect(ids([r('series', 'R1')])).toBe('e1,e2,e3,e4');
    expect(ids([r('episode', 'R1-02')])).toBe('');
  });
  it('unknown value matches nothing, NOT of it matches everything', () => {
    expect(ids([r('character', 'ghost')])).toBe('');
    expect(ids([r('character', 'ghost', 'isnot')])).toBe('e1,e2,e3,e4');
  });
  it('describes the expression', () => {
    expect(describeRules([r('character', 'lelouch'), r('location', 'ashford', 'isnot'), r('character', 'suzaku', 'is', 'or')], ds))
      .toBe('(Character is Lelouch AND Location is not Ashford Academy) OR Character is Suzaku');
  });
  it('evalRules agrees with filterEvents', () => {
    const rules = [r('character', 'lelouch')];
    expect(ds.events.filter((e) => evalRules(e, rules, ds)).length).toBe(2);
  });
});
