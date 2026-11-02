import { fold } from './fold';
import type { Entity, Episode, Ev, Kind, Raw, Series } from '../types';
import { KINDS } from '../types';

export interface DataSet {
  raw: Raw;
  entities: Map<string, Entity>;
  events: Ev[];
  eventById: Map<string, Ev>;
  episodes: Map<string, Episode>;
  episodeList: Episode[];
  series: Map<string, Series>;
  aliasIndex: Map<string, string>;
  entityEvents: Map<string, Ev[]>;
  epEvents: Map<string, Ev[]>;
}

export function buildDataSet(raw: Raw): DataSet {
  const entities = new Map(raw.entities.map((e) => [e.id, e]));
  const aliasIndex = new Map<string, string>();
  for (const e of raw.entities) {
    aliasIndex.set(fold(e.title), e.id);
  }
  for (const e of raw.entities) for (const a of e.aliases) if (!aliasIndex.has(fold(a))) aliasIndex.set(fold(a), e.id);

  const events = [...raw.events].sort((a, b) => a.order - b.order);
  const entityEvents = new Map<string, Ev[]>();
  const epEvents = new Map<string, Ev[]>();
  for (const ev of events) {
    const names: string[] = [];
    let imp = ev.review ? 0 : 1;
    const seen = new Set<string>();
    for (const k of KINDS) {
      for (const id of ev.links[k] ?? []) {
        imp += k === 'character' ? 1.2 : 1;
        const t = entities.get(id)?.title;
        if (t) names.push(t);
        if (!seen.has(id)) {
          seen.add(id);
          const arr = entityEvents.get(id);
          if (arr) arr.push(ev); else entityEvents.set(id, [ev]);
        }
      }
    }
    ev.imp = imp;
    ev.hay = fold([ev.title, ev.summary, ev.source, ...names].join(' '));
    const ea = epEvents.get(ev.ep);
    if (ea) ea.push(ev); else epEvents.set(ev.ep, [ev]);
  }
  const episodeList = [...raw.episodes].sort((a, b) => a.order - b.order);
  return {
    raw, entities, events, eventById: new Map(events.map((e) => [e.id, e])),
    episodes: new Map(episodeList.map((e) => [e.id, e])), episodeList,
    series: new Map(raw.series.map((s) => [s.id, s])), aliasIndex, entityEvents, epEvents,
  };
}

export async function loadDataSet(url: string): Promise<DataSet> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return buildDataSet((await res.json()) as Raw);
}

export const primaryKind = (e: Entity): Kind => e.kinds[0] ?? 'concept';

/** "R1 E03" */
export function epCode(ds: DataSet, epId: string): string {
  const ep = ds.episodes.get(epId);
  return ep ? `${ep.series} E${String(ep.number ?? 0).padStart(2, '0')}` : epId;
}

/** Human readable "when": the stated date when there is one, else the episode. */
export function whenLabel(ds: DataSet, ev: Ev): { code: string; date: string | null; text: string } {
  const code = epCode(ds, ev.ep);
  const date = ev.date.kind === 'absolute' ? ev.date.abs : ev.date.kind === 'relative' ? ev.date.rel : null;
  return { code, date, text: date ? `${date} · ${code}` : code };
}

export function entityStats(ds: DataSet, id: string) {
  const list = ds.entityEvents.get(id) ?? [];
  return { list, first: list[0] ?? null, last: list[list.length - 1] ?? null };
}
